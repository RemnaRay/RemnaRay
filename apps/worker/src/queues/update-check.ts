/**
 * Section 24.6: once a day the worker asks GitHub Releases which versions
 * exist, and `/admin/system` says when a newer one is out, with a "security"
 * badge for a release whose notes carry the category that `.github/release.yml`
 * fills from pull requests labelled `security`. Only published final releases
 * count: a draft is not visible anonymously and a candidate is not an update.
 *
 * GitHub's `releases/latest` orders by creation date, so a patch to an older
 * minor published later would win; the API picks the highest version from
 * this list instead.
 */
export const UPDATE_REPOSITORY = 'RemnaRay/RemnaRay';

export type PublishedRelease = {
  version: string;
  url: string;
  security: boolean;
  publishedAt: string | null;
};

type GitHubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
};

const FINAL = /^v?(\d+\.\d+\.\d+)$/u;
const SECURITY_HEADING = /^#{1,6}\s*security\b/imu;

export async function publishedReleases(
  repository: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedRelease[]> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    {
      headers: {
        // GitHub refuses a request without a User-Agent with 403.
        'User-Agent': 'remnaray-update-check',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
  const releases = (await response.json()) as GitHubRelease[];
  const published: PublishedRelease[] = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft === true || release.prerelease === true) continue;
    const version =
      typeof release.tag_name === 'string' ? FINAL.exec(release.tag_name)?.[1] : undefined;
    if (!version) continue;
    published.push({
      version,
      url: typeof release.html_url === 'string' ? release.html_url : '',
      security: typeof release.body === 'string' && SECURITY_HEADING.test(release.body),
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    });
  }
  return published;
}
