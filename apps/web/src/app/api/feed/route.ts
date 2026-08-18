import { NextResponse, type NextRequest } from 'next/server';
import { getFeed } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const after = Number(req.nextUrl.searchParams.get('after'));
  const wallet = req.nextUrl.searchParams.get('wallet') ?? undefined;
  const rows = await getFeed({
    afterId: Number.isFinite(after) && after > 0 ? after : undefined,
    wallet,
    limit: 50,
  });
  return NextResponse.json(rows);
}
