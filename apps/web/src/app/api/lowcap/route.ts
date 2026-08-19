import { NextResponse } from 'next/server';
import { getRecentLowCapBuys } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// Full list on every poll (no cursor): rows mutate — peaks and X multiples grow.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getRecentLowCapBuys());
}
