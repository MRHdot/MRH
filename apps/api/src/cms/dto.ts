import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateBlogPostDto {
  @IsString() @Length(2, 200) title: string;
  @IsOptional() @IsString() slug?: string;
  @IsObject() content: Record<string, unknown>;
  @IsOptional() @IsString() excerpt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() metaTitle?: string;
  @IsOptional() @IsString() metaDescription?: string;
  @IsOptional() @IsString() ogImageUrl?: string;
}

export class UpdateBlogPostDto {
  @IsOptional() @IsString() @Length(2, 200) title?: string;
  @IsOptional() @IsObject() content?: Record<string, unknown>;
  @IsOptional() @IsString() excerpt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() metaTitle?: string;
  @IsOptional() @IsString() metaDescription?: string;
  @IsOptional() @IsString() ogImageUrl?: string;
}

export class CreatePageDto {
  @IsString() @Length(2, 200) title: string;
  @IsOptional() @IsString() slug?: string;
  @IsArray() blocks: Record<string, unknown>[];
  @IsObject() seo: Record<string, unknown>;
}

export class UpdatePageDto {
  @IsOptional() @IsString() @Length(2, 200) title?: string;
  @IsOptional() @IsArray() blocks?: Record<string, unknown>[];
  @IsOptional() @IsObject() seo?: Record<string, unknown>;
}

export class ScheduleContentDto {
  @IsString() publishedAt: string;
}

export class RenameSlugDto {
  @IsString() @Length(1, 200) newSlug: string;
}

export class CreateRedirectDto {
  @IsString() fromPath: string;
  @IsString() toPath: string;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([301, 302]) statusCode?: number;
}

export class ProjectSeoOverrideDto {
  @IsOptional() @IsString() metaTitle?: string;
  @IsOptional() @IsString() metaDescription?: string;
  @IsOptional() @IsString() ogImageUrl?: string;
  @IsOptional() @IsBoolean() noindex?: boolean;
}

export class ListContentQuery {
  @IsOptional() @IsIn(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']) status?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class MediaAltTextDto {
  @IsOptional() @IsString() altText?: string;
}