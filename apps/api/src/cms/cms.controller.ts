import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../auth/auth.types';
import { AppError } from '../common/errors';
import {
  CreateBlogPostDto, CreatePageDto, CreateRedirectDto, ListContentQuery, MediaAltTextDto,
  ProjectSeoOverrideDto, RenameSlugDto, ScheduleContentDto, UpdateBlogPostDto, UpdatePageDto,
} from './dto';
import { CmsService } from './cms.service';

function expectedVersion(value?: string) {
  const version = Number((value ?? '').replace(/"/g, ''));
  if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'VALIDATION_ERROR', 'If-Match header with the content version is required');
  return version;
}

@Controller()
export class CmsController {
  constructor(private cms: CmsService) {}

  @RequirePermission('content.write') @Post('blog-posts') createBlog(@Body() dto: CreateBlogPostDto, @CurrentUser() user: AuthUser) { return this.cms.createBlogPost(dto, user); }
  @RequirePermission('content.read') @Get('blog-posts') listBlog(@Query() query: ListContentQuery) { return this.cms.listBlogPosts(query); }
  @Public() @Get('blog-posts/by-slug/:slug') getPublicBlog(@Param('slug') slug: string) { return this.cms.publicBlogPost(slug); }
  @RequirePermission('content.write') @Patch('blog-posts/:id') updateBlog(@Param('id') id: string, @Headers('if-match') version: string, @Body() dto: UpdateBlogPostDto) { return this.cms.updateBlogPost(id, expectedVersion(version), dto); }
  @RequirePermission('content.publish') @Post('blog-posts/:id/publish') publishBlog(@Param('id') id: string) { return this.cms.publishBlogPost(id); }
  @RequirePermission('content.publish') @Post('blog-posts/:id/schedule') scheduleBlog(@Param('id') id: string, @Body() dto: ScheduleContentDto) { return this.cms.scheduleBlogPost(id, dto.publishedAt); }
  @RequirePermission('content.publish') @Post('blog-posts/:id/archive') archiveBlog(@Param('id') id: string) { return this.cms.archiveBlogPost(id); }
  @RequirePermission('content.publish') @Post('blog-posts/:id/restore') restoreBlog(@Param('id') id: string) { return this.cms.restoreBlogPost(id); }
  @RequirePermission('content.publish') @Post('blog-posts/:id/rename-slug') renameBlog(@Param('id') id: string, @Body() dto: RenameSlugDto, @CurrentUser() user: AuthUser) { return this.cms.renameBlogPost(id, dto.newSlug, user.id); }
  @RequirePermission('content.write') @Post('blog-posts/:id/preview-token') previewBlog(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.cms.createPreviewToken('blog', id, user); }

  @RequirePermission('content.write') @Post('pages') createPage(@Body() dto: CreatePageDto, @CurrentUser() user: AuthUser) { return this.cms.createPage(dto, user); }
  @RequirePermission('content.read') @Get('pages') listPages(@Query() query: ListContentQuery) { return this.cms.listPages(query); }
  @Public() @Get('pages/by-slug/:slug') getPublicPage(@Param('slug') slug: string) { return this.cms.publicPage(slug); }
  @Public() @Get('pages/by-path') getPublicPageByPath(@Query('path') path: string) { return this.cms.publicPage(path); }
  @RequirePermission('content.write') @Patch('pages/:id') updatePage(@Param('id') id: string, @Headers('if-match') version: string, @Body() dto: UpdatePageDto) { return this.cms.updatePage(id, expectedVersion(version), dto); }
  @RequirePermission('content.publish') @Post('pages/:id/publish') publishPage(@Param('id') id: string) { return this.cms.publishPage(id); }
  @RequirePermission('content.publish') @Post('pages/:id/schedule') schedulePage(@Param('id') id: string, @Body() dto: ScheduleContentDto) { return this.cms.schedulePage(id, dto.publishedAt); }
  @RequirePermission('content.publish') @Post('pages/:id/archive') archivePage(@Param('id') id: string) { return this.cms.archivePage(id); }
  @RequirePermission('content.publish') @Post('pages/:id/restore') restorePage(@Param('id') id: string) { return this.cms.restorePage(id); }
  @RequirePermission('content.write') @Post('pages/:id/preview-token') previewPage(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.cms.createPreviewToken('page', id, user); }

  @RequirePermission('redirects.manage') @Post('redirects') createRedirect(@Body() dto: CreateRedirectDto, @CurrentUser() user: AuthUser) { return this.cms.createRedirect(dto, user.id); }
  @RequirePermission('redirects.manage') @Get('redirects') listRedirects() { return this.cms.listRedirects(); }
  @Public() @Get('redirects/resolve') resolveRedirect(@Query('path') path: string) { return this.cms.resolveRedirect(path); }
  @RequirePermission('redirects.manage') @Delete('redirects/:id') deleteRedirect(@Param('id') id: string) { return this.cms.deleteRedirect(id); }

  @RequirePermission('projects.seo.read') @Get('projects/:id/seo-override') getProjectSeo(@Param('id') id: string) { return this.cms.getProjectSeoOverride(id); }
  @RequirePermission('projects.seo.write') @Put('projects/:id/seo-override') putProjectSeo(@Param('id') id: string, @Body() dto: ProjectSeoOverrideDto) { return this.cms.putProjectSeoOverride(id, dto); }
  @Public() @Get('sitemap-entries') sitemapEntries() { return this.cms.listSitemapEntries(); }

  @RequirePermission('media.manage') @Get('media') listMedia(@Query('missingAltText') missingAltText?: string) { return this.cms.listMedia(missingAltText === 'true'); }
  @RequirePermission('media.manage') @Patch('media/:id') updateMedia(@Param('id') id: string, @Body() dto: MediaAltTextDto) { return this.cms.updateMediaAltText(id, dto.altText); }
}