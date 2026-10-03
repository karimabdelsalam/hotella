import { Activation } from '../../../../components/activation';

/** The activation link the hotel sends (Spec §19.1). */
export default async function ActivationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Activation mode="link" token={token} />;
}
