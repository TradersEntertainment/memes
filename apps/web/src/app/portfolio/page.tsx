import { PaperPortfolio } from '@/components/paper-portfolio';
import { Card } from '@/components/ui';
import { getPaperPortfolio } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const portfolio = await getPaperPortfolio();
  return (
    <div className="space-y-4">
      <Card title="🧪 Simulation portfolio — what the auto-buy bought">
        <PaperPortfolio initial={portfolio} />
      </Card>
    </div>
  );
}
