import { BadRequestException, ConflictException } from '@nestjs/common';
import { CmsService } from './cms.service';

describe('CmsService redirects', () => {
  const redirectRows = new Map<string, { toPath: string }>();
  const prisma: any = {
    redirect: {
      findUnique: jest.fn(async ({ where }: any) => redirectRows.get(where.fromPath) ?? null),
    },
    $transaction: jest.fn(async (work: any) => work({
      redirect: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          for (const row of redirectRows.values()) if (row.toPath === where.toPath) row.toPath = data.toPath;
          return { count: 0 };
        }),
        create: jest.fn(async ({ data }: any) => {
          redirectRows.set(data.fromPath, { toPath: data.toPath });
          return data;
        }),
      },
    })),
  };
  const events: any = { emit: jest.fn() };
  const service = new CmsService(prisma, events, {} as any, {} as any, { revalidate: jest.fn() } as any);

  beforeEach(() => {
    redirectRows.clear();
    jest.clearAllMocks();
  });

  it('rejects self redirects and external destinations', async () => {
    await expect(service.createRedirect({ fromPath: '/same', toPath: '/same' }, 'actor')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.createRedirect({ fromPath: '/old', toPath: 'https://example.com' }, 'actor')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('flattens existing chains and rejects loops', async () => {
    redirectRows.set('/b', { toPath: '/c' });
    await service.createRedirect({ fromPath: '/a', toPath: '/b' }, 'actor');
    expect(redirectRows.get('/a')?.toPath).toBe('/c');

    redirectRows.set('/c', { toPath: '/a' });
    await expect(service.createRedirect({ fromPath: '/a', toPath: '/c' }, 'actor')).rejects.toBeInstanceOf(ConflictException);
  });
});