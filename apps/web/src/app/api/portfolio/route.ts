import { NextResponse } from 'next/server';
import { getPaperPortfolio } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// Full snapshot on every poll: rows mutate (last/peak market caps keep moving).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getPaperPortfolio());
}
