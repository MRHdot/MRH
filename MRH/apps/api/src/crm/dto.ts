import { LeadSource, LeadStatus, ActivityType, DealStage, VisitOutcome, VisitStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Length, Max, Min } from 'class-validator';

export class CreateLeadDto {
  @IsString() @Length(2, 120) name: string;
  @IsString() phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsEnum(LeadSource) source: LeadSource;
  @IsOptional() @IsString() projectInterest?: string;
  @IsOptional() @IsInt() @Min(0) budgetMin?: number;
  @IsOptional() @IsInt() @Min(0) budgetMax?: number;
  /** DPDP: when true, consentText (verbatim wording shown to the person) is mandatory. */
  @IsOptional() @IsBoolean() consentGiven?: boolean;
  @IsOptional() @IsString() consentText?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() projectInterest?: string;
  @IsOptional() @IsInt() @Min(0) budgetMin?: number;
  @IsOptional() @IsInt() @Min(0) budgetMax?: number;
}

export class ChangeStatusDto {
  @IsEnum(LeadStatus) status: LeadStatus;
  @IsOptional() @IsString() lostReason?: string;
  @IsOptional() @IsString() notes?: string;
}
export class AssignDto { @IsString() agentId: string; }
export class ReactivateDto { @IsOptional() @IsString() notes?: string; }

export class ListLeadsQuery {
  @IsOptional() @IsString() status?: string;            // comma-separated
  @IsOptional() @IsString() assignedTo?: string;
  @IsOptional() @IsEnum(LeadSource) source?: LeadSource;
  @IsOptional() @IsString() slaBreached?: string;       // "true" | "false"
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class PipelineQuery {
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() projectInterest?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
}

export class CreateActivityDto {
  @IsEnum(ActivityType) type: ActivityType;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() metadata?: Record<string, unknown>;
}

export class CreateVisitDto {
  @IsString() leadId: string;
  @IsOptional() @IsString() unitId?: string;
  @IsDateString() scheduledAt: string;
  @IsOptional() @IsInt() @Min(15) @Max(480) durationMins?: number;
}
export class UpdateVisitDto {
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsEnum(VisitStatus) status?: VisitStatus;
  @IsOptional() @IsEnum(VisitOutcome) outcome?: VisitOutcome;
  @IsOptional() @IsString() feedback?: string;
}

export class CreateDealDto {
  @IsString() leadId: string;
  @IsString() unitId: string;
  @IsNumber() @IsPositive() value: number;
  @IsNumber() @Min(0) @Max(100) commissionPercent: number;
}
export class UpdateDealDto {
  @IsOptional() @IsNumber() @IsPositive() value?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) commissionPercent?: number;
}
export class DealStageDto {
  @IsEnum(DealStage) stage: DealStage;
  @IsOptional() @IsString() lostReason?: string;
}
export class ExtendHoldDto { @IsInt() @Min(1) @Max(168) additionalHours: number; }
