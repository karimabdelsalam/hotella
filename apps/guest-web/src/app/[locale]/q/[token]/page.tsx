import { Activation } from '../../../../components/activation';

/** The room QR code (Spec §20): an opaque token, then the guest proves who they are. */
export default async function RoomQrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Activation mode="qr" token={token} />;
}
