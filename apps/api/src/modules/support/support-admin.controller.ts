import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Permissions } from '../admin/admin.rbac';
import { Audit } from '../admin/audit.interceptor';
import { AuthGuard } from '../auth/auth.guards';
import { SupportAdminService } from './support-admin.service';

/** `/api/admin/v1/support` (owner decision F36): operators read, admins edit. */
@Controller('api/admin/v1/support')
@UseGuards(AuthGuard)
@Permissions('support.read')
export class SupportAdminController {
  constructor(private readonly support: SupportAdminService) {}

  @Get('stats')
  stats(@Query() query: unknown) {
    return this.support.stats(query);
  }

  @Get('templates')
  templates() {
    return this.support.templates();
  }

  @Post('templates')
  @HttpCode(201)
  @Permissions('support.write')
  @Audit('support.templates.create', 'support_template')
  createTemplate(@Body() body: unknown) {
    return this.support.createTemplate(body);
  }

  @Put('templates/:id')
  @Permissions('support.write')
  @Audit('support.templates.update', 'support_template', 'id')
  updateTemplate(@Param('id') id: string, @Body() body: unknown) {
    return this.support.updateTemplate(id, body);
  }

  @Delete('templates/:id')
  @Permissions('support.write')
  @Audit('support.templates.delete', 'support_template', 'id')
  deleteTemplate(@Param('id') id: string) {
    return this.support.deleteTemplate(id);
  }
}
