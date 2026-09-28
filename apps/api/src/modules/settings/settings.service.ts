import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { decryptSetting, encryptSetting } from './settings.crypto';
import {
  settingDefinitions,
  settingKey,
  settingRegistry,
  settingsGroups,
  settingsImportSchema,
  settingsPatchSchema,
  type SettingsGroup,
  type SettingsPatch,
} from './settings.schemas';
import { type SettingsRepositoryPort, type SettingWrite } from './settings.repository';
import { type SettingsChangedEvent, type SettingsEventBusPort } from './settings.events';

export type SettingsActor = { id?: string } | undefined;

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, unknown>();
  private loaded = false;

  constructor(
    private readonly repository: SettingsRepositoryPort,
    private readonly eventBus: SettingsEventBusPort,
    private readonly appKey = process.env.RR_APP_KEY ?? '',
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload(true);
    await this.eventBus.subscribe((event) => {
      this.invalidate(event);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.eventBus.close();
  }

  async get(key: string): Promise<unknown> {
    await this.ensureLoaded();
    const definition = settingDefinitions.get(key);
    if (!definition) throw new Error(`Unknown setting key: ${key}`);
    return this.cache.get(key) ?? structuredClone(definition.defaultValue);
  }

  async getGroup(group: SettingsGroup, includeSecrets = false): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const definition of settingRegistry.filter((item) => item.group === group)) {
      const value = await this.get(settingKey(group, definition.name));
      result[definition.name] =
        includeSecrets || !definition.secret
          ? value
          : { set: this.cache.has(settingKey(group, definition.name)) };
    }
    return result;
  }

  async getAll(includeSecrets = false): Promise<Record<string, Record<string, unknown>>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const group of settingsGroups) result[group] = await this.getGroup(group, includeSecrets);
    return result;
  }

  async set(patch: unknown, actor?: SettingsActor): Promise<void> {
    await this.ensureLoaded();
    const parsedPatch: SettingsPatch = settingsPatchSchema.parse(patch);
    const writes: SettingWrite[] = [];
    const changedKeys: string[] = [];

    for (const [groupName, groupPatch] of Object.entries(parsedPatch)) {
      if (!settingsGroups.includes(groupName as SettingsGroup)) {
        throw new Error(`Unknown settings group: ${groupName}`);
      }
      const group = groupName as SettingsGroup;
      const knownNames = new Set(
        settingRegistry.filter((item) => item.group === group).map((item) => item.name),
      );
      for (const name of Object.keys(groupPatch)) {
        if (!knownNames.has(name)) throw new Error(`Unknown setting key: ${groupName}.${name}`);
      }
      const current = await this.getGroup(group, true);
      const merged = { ...current, ...groupPatch };
      const definitions = settingRegistry.filter((item) => item.group === group);

      for (const definition of definitions) {
        const fullKey = settingKey(group, definition.name);
        const value = merged[definition.name];
        if (!(definition.name in groupPatch)) continue;

        if (definition.secret && this.isSecretMarker(value) && value.set) {
          if (!this.cache.has(fullKey)) throw new Error(`Cannot preserve unset secret ${fullKey}`);
          continue;
        }
        const parsed = definition.schema.parse(value);

        writes.push({
          key: fullKey,
          value: definition.secret ? encryptSetting(parsed, this.appKey) : parsed,
          isSecret: definition.secret,
        });
        changedKeys.push(fullKey);
      }
    }

    if (writes.length === 0) return;
    await this.repository.replace(writes, actor?.id);
    for (const write of writes) {
      const definition = settingDefinitions.get(write.key);
      if (definition)
        this.cache.set(write.key, definition.secret ? this.decrypt(write.value) : write.value);
    }
    await this.eventBus.publish({ keys: changedKeys, version: Date.now() });
  }

  /**
   * Section 17.6 reaction matrix. Every key invalidates the shared cache; these
   * prefixes additionally ask another process to reconfigure itself.
   */
  static sideEffects(keys: string[]): { channels: string[]; restartRequired: string[] } {
    const channels = new Set<string>();
    for (const key of keys) {
      if (key.startsWith('bot.')) channels.add('rr:bot.reconfigure');
      if (key.startsWith('domain.')) channels.add('rr:proxy.reload');
      if (key.startsWith('theme.')) channels.add('rr:theme.changed');
      if (key.startsWith('locale.')) channels.add('rr:i18n.changed');
    }
    // Nothing in the section 17.3 registry needs a restart in v1.
    return { channels: [...channels], restartRequired: [] };
  }

  /** Diff between the stored settings and an import snapshot, for `dryRun`. */
  async diff(value: unknown): Promise<{ key: string; from: unknown; to: unknown }[]> {
    const parsed = settingsImportSchema.parse(value);
    const current = await this.flat(false);
    const diff: { key: string; from: unknown; to: unknown }[] = [];
    for (const [group, values] of Object.entries(parsed.settings)) {
      for (const [name, next] of Object.entries(values)) {
        const key = `${group}.${name}`;
        const definition = settingDefinitions.get(key);
        if (!definition) continue;
        const from = current[key];
        if (JSON.stringify(from) !== JSON.stringify(next))
          diff.push({
            key,
            from: definition.secret ? { set: Boolean(from) } : from,
            to: definition.secret ? { set: true } : next,
          });
      }
    }
    return diff;
  }

  /** Publishes the section 17.6 channels for the keys that just changed. */
  async announce(keys: string[], publish: (channel: string, payload: string) => Promise<unknown>) {
    const { channels } = SettingsService.sideEffects(keys);
    for (const channel of channels)
      await publish(channel, JSON.stringify({ keys, at: Date.now() })).catch(() => undefined);
    return channels;
  }

  async exportSnapshot(): Promise<{
    version: 1;
    settings: Record<string, Record<string, unknown>>;
  }> {
    return { version: 1, settings: await this.getAll(false) };
  }

  async importSnapshot(value: unknown, actor?: SettingsActor): Promise<void> {
    const parsed = settingsImportSchema.parse(value);
    await this.set(parsed.settings, actor);
  }

  schema(): Array<{
    key: string;
    group: SettingsGroup;
    type: string;
    default: unknown;
    secret: boolean;
    description: string;
  }> {
    return settingRegistry.map((definition) => ({
      key: settingKey(definition.group, definition.name),
      group: definition.group,
      type: definition.schema.constructor.name,
      default: definition.secret ? { set: false } : definition.defaultValue,
      secret: definition.secret,
      description: definition.description,
    }));
  }

  async flat(includeSecrets = false): Promise<Record<string, unknown>> {
    const groups = await this.getAll(includeSecrets);
    const result: Record<string, unknown> = {};
    for (const [group, values] of Object.entries(groups)) {
      for (const [name, value] of Object.entries(values)) result[`${group}.${name}`] = value;
    }
    return result;
  }

  schemaJson(): { version: 1; type: 'object'; properties: Record<string, unknown> } {
    const properties: Record<string, unknown> = {};
    for (const definition of settingRegistry) {
      properties[settingKey(definition.group, definition.name)] = {
        title: definition.name,
        description: definition.description,
        default: definition.secret ? { set: false } : definition.defaultValue,
        'x-secret': definition.secret,
      };
    }
    return { version: 1, type: 'object', properties };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.reload();
  }

  /**
   * `starting`: R29 — a key that decrypts none of the stored secrets is not
   * the key they were saved with, and the process stops (section 17.2)
   * instead of running with every secret at its empty default. One value
   * that fails among readable ones is section 17.5's case: logged, default.
   */
  private async reload(starting = false): Promise<void> {
    const stored = await this.repository.list();
    this.cache.clear();
    let secrets = 0;
    let unreadable = 0;
    for (const setting of stored) {
      const definition = settingDefinitions.get(setting.key);
      if (!definition) {
        this.logger.warn(`Ignoring unknown setting ${setting.key}`);
        continue;
      }
      let value = setting.value;
      if (setting.isSecret) {
        secrets += 1;
        try {
          value = this.decrypt(setting.value);
        } catch (error) {
          unreadable += 1;
          this.logger.error(`Setting ${setting.key} does not decrypt; using its default`, error);
          continue;
        }
      }
      try {
        this.cache.set(setting.key, definition.schema.parse(value));
      } catch (error) {
        this.logger.error(`Invalid setting ${setting.key}; using its default`, error);
      }
    }
    if (starting && secrets > 0 && unreadable === secrets)
      throw new Error(
        `RR_APP_KEY decrypts none of the ${String(secrets)} stored secrets: it is not the key ` +
          'they were saved with. Put that key back in .env, or change keys with ' +
          './scripts/rr rotate-key.',
      );
    this.loaded = true;
  }

  private invalidate(event: SettingsChangedEvent): void {
    if (event.keys.length === 0) this.cache.clear();
    else for (const key of event.keys) this.cache.delete(key);
    this.loaded = false;
  }

  private decrypt(value: unknown): unknown {
    if (!this.appKey) throw new Error('RR_APP_KEY is required to decrypt settings');
    return decryptSetting(value, this.appKey);
  }

  private isSecretMarker(value: unknown): value is { set: boolean } {
    return typeof value === 'object' && value !== null && 'set' in value;
  }
}
