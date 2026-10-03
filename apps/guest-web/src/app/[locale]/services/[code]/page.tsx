import { ServiceForm } from '../../../../components/service-form';

export default async function ServicePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ServiceForm code={code} />;
}
