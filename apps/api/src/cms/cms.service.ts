import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from '../auth/auth.types';
import { ProjectCatalogPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';
import { RevalidationService } from './revalidation.service';
import {
  CreateBlogPostDto, CreatePageDto, CreateRedirectDto, ListContentQuery, ProjectSeoOverrideDto,
  UpdateBlogPostDto, UpdatePageDto,
} from './dto';

const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');

function collectImageRefs(value: unknown, refs = new Set<string>(), imageContext = false): Set<string> {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectImageRefs(item, refs, imageContext);
    return refs;
  }
  const record = value as Record<string, unknown>;
  const isImage = imageContext || record.type === 'image';
  for (const [key, child] of Object.entries(record)) {
    const imageField = isImage || /^(mediaId|mediaIds|imageUrl|imageUrls|src)$/i.test(key);
    if (imageField && typeof child === 'string') refs.add(child);
    else if (imageField && Array.isArray(child)) {
      for (const ref of child) if (typeof ref === 'string') refs.add(ref);
    }
    if (child && typeof child === 'object') collectImageRefs(child, refs, imageField);
  }
  return refs;
}

function cleanPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#]/.test(path)) {
    throw new BadRequestException('Redirect paths must be local absolute paths without query or fragment');
  }
  const normalized = `/${path.split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? normalized : normalized.toLowerCase();
}

@Injectable()
export class CmsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
    private jwt: JwtService,
    private inventory: ProjectCatalogPort,
    private revalidation: RevalidationService,
  ) {}

  private async uniqueSlug(title: string, exists: (slug: string) => Promise<boolean>) {
    const base = slugify(title) || 'untitled';
    let candidate = base;
    for (let suffix = 2; await exists(candidate); suffix++) candidate = `${base}-${suffix}`;
    return candidate;
  }

  async createBlogPost(dto: CreateBlogPostDto, user: AuthUser) {
    const slug = dto.slug ? slugify(dto.slug) : await this.uniqueSlug(dto.title, async (value) => !!await this.prisma.blogPost.findUnique({ where: { slug: value } }));
    if (!slug) throw new ConflictException('A valid non-empty slug is required');
    if (await this.prisma.blogPost.findUnique({ where: { slug } })) throw new ConflictException('Slug is already in use');
    return this.prisma.blogPost.create({ data: {
      title: dto.title, slug, content: dto.content as Prisma.InputJsonValue, excerpt: dto.excerpt,
      tags: dto.tags ?? [], metaTitle: dto.metaTitle ?? dto.title,
      metaDescription: dto.metaDescription ?? dto.excerpt ?? '', ogImageUrl: dto.ogImageUrl, authorId: user.id,
    } });
  }

  async listBlogPosts(query: ListContentQuery) {
    const limit = query.limit ?? 25;
    const items = await this.prisma.blogPost.findMany({
      where: query.status ? { status: query.status as ContentStatus } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return { data, meta: { nextCursor: hasMore ? data[data.length - 1].id : null } };
  }

  async publicBlogPost(slug: string) {
    const post = await this.prisma.blogPost.findFirst({ where: { slug, status: 'PUBLISHED' } });
    if (!post) throw new NotFoundException('Blog post not found');
    return post;
  }

  async updateBlogPost(id: string, version: number, dto: UpdateBlogPostDto) {
    const data: Prisma.BlogPostUpdateManyMutationInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.content !== undefined ? { content: dto.content as Prisma.InputJsonValue } : {}),
      ...(dto.excerpt !== undefined ? { excerpt: dto.excerpt } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.metaTitle !== undefined ? { metaTitle: dto.metaTitle } : {}),
      ...(dto.metaDescription !== undefined ? { metaDescription: dto.metaDescription } : {}),
      ...(dto.ogImageUrl !== undefined ? { ogImageUrl: dto.ogImageUrl } : {}),
      version: { increment: 1 },
    };
    const updated = await this.prisma.blogPost.updateMany({
      where: { id, version },
      data,
    });
    if (!updated.count) {
      const existing = await this.prisma.blogPost.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Blog post not found');
      throw new ConflictException('Content version changed; use the slug rename endpoint for URL changes');
    }
    const saved = await this.prisma.blogPost.findUniqueOrThrow({ where: { id } });
    if (saved.status === 'PUBLISHED') await this.revalidation.revalidate(`/blog/${saved.slug}`);
    return saved;
  }

  async createPage(dto: CreatePageDto, user: AuthUser) {
    const slug = dto.slug ? cleanPath(dto.slug) : `/${await this.uniqueSlug(dto.title, async (value) => !!await this.prisma.page.findUnique({ where: { slug: `/${value}` } }))}`;
    if (await this.prisma.page.findUnique({ where: { slug } })) throw new ConflictException('Slug is already in use');
    return this.prisma.page.create({ data: {
      title: dto.title, slug, blocks: dto.blocks as Prisma.InputJsonValue,
      seo: dto.seo as Prisma.InputJsonValue, lastEditedBy: user.id,
    } });
  }

  async listPages(query: ListContentQuery) {
    const limit = query.limit ?? 25;
    const items = await this.prisma.page.findMany({
      where: query.status ? { status: query.status as ContentStatus } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return { data, meta: { nextCursor: hasMore ? data[data.length - 1].id : null } };
  }

  async publicPage(slug: string) {
    const path = cleanPath(slug);
    const page = await this.prisma.page.findFirst({ where: { slug: path, status: 'PUBLISHED' } });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  async updatePage(id: string, version: number, dto: UpdatePageDto) {
    const data: Prisma.PageUpdateManyMutationInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.blocks !== undefined ? { blocks: dto.blocks as Prisma.InputJsonValue } : {}),
      ...(dto.seo !== undefined ? { seo: dto.seo as Prisma.InputJsonValue } : {}),
      version: { increment: 1 },
    };
    const updated = await this.prisma.page.updateMany({
      where: { id, version },
      data,
    });
    if (!updated.count) {
      const existing = await this.prisma.page.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Page not found');
      throw new ConflictException('Content version changed');
    }
    const saved = await this.prisma.page.findUniqueOrThrow({ where: { id } });
    if (saved.status === 'PUBLISHED') await this.revalidation.revalidate(saved.slug);
    return saved;
  }

  private async validatePublish(seoTitle: string | null | undefined, description: string | null | undefined, content: unknown) {
    if (!seoTitle?.trim() || !description?.trim()) throw new UnprocessableEntityException({ code: 'INCOMPLETE_SEO_FIELDS', message: 'SEO title and description are required before publishing' });
    const refs = [...collectImageRefs(content)];
    if (!refs.length) return;
    const media = await this.prisma.media.findMany({ where: { OR: [{ id: { in: refs } }, { url: { in: refs } }] } });
    const found = new Set(media.flatMap((item) => [item.id, item.url]));
    const missing = refs.filter((ref) => !found.has(ref) || !media.find((item) => item.id === ref || item.url === ref)?.altText?.trim());
    if (missing.length) throw new UnprocessableEntityException({ code: 'MISSING_ALT_TEXT', message: 'Every published image must have alt text and a Media record', media: missing });
  }

  private async transitionBlog(id: string, to: ContentStatus, publishedAt?: Date) {
    const post = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Blog post not found');
    const allowed = (post.status === 'DRAFT' && (to === 'PUBLISHED' || to === 'SCHEDULED'))
      || (post.status === 'SCHEDULED' && (to === 'PUBLISHED' || to === 'DRAFT'))
      || (post.status === 'PUBLISHED' && to === 'ARCHIVED')
      || (post.status === 'ARCHIVED' && to === 'DRAFT');
    if (!allowed) throw new ConflictException(`Invalid content transition: ${post.status} to ${to}`);
    if (to === 'SCHEDULED' && (!publishedAt || publishedAt <= new Date())) throw new UnprocessableEntityException('publishedAt must be a future date');
    if (to === 'PUBLISHED') await this.validatePublish(post.metaTitle, post.metaDescription, post.content);
    const changed = await this.prisma.blogPost.updateMany({ where: { id, status: post.status }, data: {
      status: to, publishedAt: to === 'PUBLISHED' ? new Date() : to === 'DRAFT' ? null : publishedAt ?? post.publishedAt,
      version: { increment: 1 },
    } });
    if (!changed.count) throw new ConflictException('Content changed during its lifecycle transition; retry the action');
    const saved = await this.prisma.blogPost.findUniqueOrThrow({ where: { id } });
    if (to === 'PUBLISHED' || to === 'ARCHIVED') {
      const event = to === 'PUBLISHED' ? 'content.published' : 'content.archived';
      this.events.emit(event, { contentType: 'BlogPost', contentId: id, path: `/blog/${post.slug}` });
      await this.revalidation.revalidate(`/blog/${post.slug}`);
    }
    return saved;
  }

  private async transitionPage(id: string, to: ContentStatus, publishedAt?: Date) {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) throw new NotFoundException('Page not found');
    const allowed = (page.status === 'DRAFT' && (to === 'PUBLISHED' || to === 'SCHEDULED'))
      || (page.status === 'SCHEDULED' && (to === 'PUBLISHED' || to === 'DRAFT'))
      || (page.status === 'PUBLISHED' && to === 'ARCHIVED')
      || (page.status === 'ARCHIVED' && to === 'DRAFT');
    if (!allowed) throw new ConflictException(`Invalid content transition: ${page.status} to ${to}`);
    if (to === 'SCHEDULED' && (!publishedAt || publishedAt <= new Date())) throw new UnprocessableEntityException('publishedAt must be a future date');
    const seo = page.seo as { title?: string; description?: string };
    if (to === 'PUBLISHED') await this.validatePublish(seo.title ?? page.title, seo.description, page.blocks);
    const changed = await this.prisma.page.updateMany({ where: { id, status: page.status }, data: {
      status: to, publishedAt: to === 'PUBLISHED' ? new Date() : to === 'DRAFT' ? null : publishedAt ?? page.publishedAt,
      version: { increment: 1 },
    } });
    if (!changed.count) throw new ConflictException('Content changed during its lifecycle transition; retry the action');
    const saved = await this.prisma.page.findUniqueOrThrow({ where: { id } });
    if (to === 'PUBLISHED' || to === 'ARCHIVED') {
      const event = to === 'PUBLISHED' ? 'content.published' : 'content.archived';
      this.events.emit(event, { contentType: 'Page', contentId: id, path: page.slug });
      await this.revalidation.revalidate(page.slug);
      await this.revalidation.revalidate('/sitemap.xml');
    }
    return saved;
  }

  publishBlogPost(id: string) { return this.transitionBlog(id, 'PUBLISHED'); }
  scheduleBlogPost(id: string, at: string) { return this.transitionBlog(id, 'SCHEDULED', new Date(at)); }
  archiveBlogPost(id: string) { return this.transitionBlog(id, 'ARCHIVED'); }
  restoreBlogPost(id: string) { return this.transitionBlog(id, 'DRAFT'); }
  publishPage(id: string) { return this.transitionPage(id, 'PUBLISHED'); }
  schedulePage(id: string, at: string) { return this.transitionPage(id, 'SCHEDULED', new Date(at)); }
  archivePage(id: string) { return this.transitionPage(id, 'ARCHIVED'); }
  restorePage(id: string) { return this.transitionPage(id, 'DRAFT'); }

  async publishDueContent() {
    const dueAt = new Date();
    const [posts, pages] = await Promise.all([
      this.prisma.blogPost.findMany({ where: { status: 'SCHEDULED', publishedAt: { lte: dueAt } }, select: { id: true } }),
      this.prisma.page.findMany({ where: { status: 'SCHEDULED', publishedAt: { lte: dueAt } }, select: { id: true } }),
    ]);
    for (const post of posts) {
      try { await this.transitionBlog(post.id, 'PUBLISHED'); }
      catch (error) { this.events.emit('content.publish_failed', { contentType: 'BlogPost', contentId: post.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    for (const page of pages) {
      try { await this.transitionPage(page.id, 'PUBLISHED'); }
      catch (error) { this.events.emit('content.publish_failed', { contentType: 'Page', contentId: page.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { posts: posts.length, pages: pages.length };
  }

  async renameBlogPost(id: string, newSlug: string, actorId: string) {
    const post = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Blog post not found');
    const slug = slugify(newSlug);
    if (!slug || slug === post.slug) throw new ConflictException('A different valid slug is required');
    const existing = await this.prisma.blogPost.findUnique({ where: { slug } });
    if (existing) throw new ConflictException('Slug is already in use');
    const result = await this.prisma.$transaction(async (tx) => {
      const redirect = await tx.redirect.create({ data: { fromPath: `/blog/${post.slug}`, toPath: `/blog/${slug}`, createdBy: actorId } });
      const updated = await tx.blogPost.update({ where: { id }, data: { slug, version: { increment: 1 } } });
      return { redirect, updated };
    });
    this.events.emit('redirect.created', { redirectId: result.redirect.id, fromPath: result.redirect.fromPath, toPath: result.redirect.toPath });
    await this.revalidation.revalidate(`/blog/${post.slug}`);
    await this.revalidation.revalidate(`/blog/${slug}`);
    return result.updated;
  }

  async createRedirect(dto: CreateRedirectDto, actorId: string) {
    const fromPath = cleanPath(dto.fromPath);
    let toPath = cleanPath(dto.toPath);
    if (fromPath === toPath) throw new ConflictException({ code: 'REDIRECT_LOOP', message: 'A redirect cannot point to itself' });
    const visited = new Set([fromPath]);
    for (let depth = 0; depth < 20; depth++) {
      if (visited.has(toPath)) throw new ConflictException({ code: 'REDIRECT_LOOP', message: 'This redirect would create a loop' });
      visited.add(toPath);
      const next = await this.prisma.redirect.findUnique({ where: { fromPath: toPath }, select: { toPath: true } });
      if (!next) break;
      toPath = next.toPath;
      if (depth === 19) throw new ConflictException('Redirect chain exceeds the supported depth');
    }
    const redirect = await this.prisma.$transaction(async (tx) => {
      await tx.redirect.updateMany({ where: { toPath: fromPath }, data: { toPath } });
      return tx.redirect.create({ data: { fromPath, toPath, statusCode: dto.statusCode ?? 301, createdBy: actorId } });
    });
    this.events.emit('redirect.created', { redirectId: redirect.id, fromPath, toPath });
    return redirect;
  }

  listRedirects() { return this.prisma.redirect.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }); }

  resolveRedirect(path: string) {
    return this.prisma.redirect.findUnique({ where: { fromPath: cleanPath(path) }, select: { toPath: true, statusCode: true } });
  }

  async deleteRedirect(id: string) {
    const result = await this.prisma.redirect.deleteMany({ where: { id } });
    if (!result.count) throw new NotFoundException('Redirect not found');
    return { deleted: true };
  }

  getProjectSeoOverride(projectId: string) {
    return this.prisma.projectSeoOverride.findUnique({ where: { projectId } });
  }

  async putProjectSeoOverride(projectId: string, dto: ProjectSeoOverrideDto) {
    await this.inventory.assertProjectExists(projectId);
    return this.prisma.projectSeoOverride.upsert({
      where: { projectId }, update: dto, create: { projectId, ...dto },
    });
  }

  async createPreviewToken(type: 'blog' | 'page', id: string, user: AuthUser) {
    if (type === 'blog') {
      const post = await this.prisma.blogPost.findUnique({ where: { id }, select: { slug: true } });
      if (!post) throw new NotFoundException('Blog post not found');
      return { token: this.jwt.sign({ sub: user.id, contentId: id, path: `/blog/${post.slug}`, type }, { expiresIn: '15m' }), path: `/blog/${post.slug}`, expiresIn: 900 };
    }
    const page = await this.prisma.page.findUnique({ where: { id }, select: { slug: true } });
    if (!page) throw new NotFoundException('Page not found');
    return { token: this.jwt.sign({ sub: user.id, contentId: id, path: page.slug, type }, { expiresIn: '15m' }), path: page.slug, expiresIn: 900 };
  }

  async listSitemapEntries() {
    const [pages, posts] = await Promise.all([
      this.prisma.page.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true, seo: true } }),
      this.prisma.blogPost.findMany({ where: { status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
    ]);
    return [
      ...pages.filter((page) => !(page.seo as { noindex?: boolean }).noindex).map((page) => ({ path: page.slug, lastModified: page.updatedAt })),
      ...posts.map((post) => ({ path: `/blog/${post.slug}`, lastModified: post.updatedAt })),
    ];
  }

  listMedia(missingAltText: boolean) {
    return this.prisma.media.findMany({
      where: missingAltText ? { OR: [{ altText: null }, { altText: '' }] } : {},
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  async updateMediaAltText(id: string, altText?: string) {
    try { return await this.prisma.media.update({ where: { id }, data: { altText: altText?.trim() || null } }); }
    catch { throw new NotFoundException('Media not found'); }
  }
}