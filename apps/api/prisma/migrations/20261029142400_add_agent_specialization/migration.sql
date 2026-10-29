ALTER TABLE "User"
ADD COLUMN "specialization" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Lead"
ADD COLUMN "referredBy" TEXT;

CREATE INDEX "Lead_referredBy_idx" ON "Lead"("referredBy");

ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_referredBy_fkey"
FOREIGN KEY ("referredBy") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
