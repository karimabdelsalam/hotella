# Push notifications to the Hotella staff app

The platform sends staff notifications (new task, escalation, approval needed…) to the **Hotella** app through
**Firebase Cloud Messaging (FCM) HTTP v1**. FCM delivers to Android directly and to iPhones through Apple's push
service (APNs) with the key you upload to Firebase. A push carries only a generic title for its category ("New task
for you") and references; the app fetches the details over the API, so no guest data passes through Google or Apple
(ADR-0023). Until the steps below are done, push deliveries are recorded as skipped and staff still see everything in
the in-app inbox.

## Once, in the Firebase console (Planova's Google account)

1. Create the project, e.g. `hotella-prod` (Google Analytics: off). Note its **project ID**.
2. **Android app**: add an Android app with package name `eg.planova.hotella`. You do not need to download
   `google-services.json`; note the **App ID** (`1:…:android:…`), the **Web API key** and the **Sender ID**
   (Project settings → General and → Cloud Messaging).
3. **iOS app**: add an iOS app with bundle ID `eg.planova.hotella`; note its **App ID** (`1:…:ios:…`).
4. **APNs key (Apple Developer account)**: Certificates, Identifiers & Profiles → Keys → **+** → enable *Apple Push
   Notifications service (APNs)* → download the `.p8` file (only once) and note the **Key ID** and your **Team ID**.
   In Firebase: Project settings → Cloud Messaging → Apple app configuration → upload the `.p8` with Key ID and Team
   ID. In the Apple Developer account, the App ID `eg.planova.hotella` must have the *Push Notifications* capability.
5. **Service account for the platform**: Project settings → Service accounts → *Generate new private key*. This JSON
   file is a secret: copy it to the server over SSH, never e-mail it, never commit it.

## Once, on the server

```bash
sudo hotella push-setup hotella-prod /root/hotella-prod-firebase.json
shred -u /root/hotella-prod-firebase.json
```

`push-setup` checks that the file is that project's service-account key, writes it to OpenBao
(`kv/hotella/app#fcm_service_account`, read only by the API and worker AppRoles), sets `HOTELLA_FCM_PROJECT_ID` in
`infra/docker/.env` and restarts the API and worker. It needs an OpenBao token that may write `kv/hotella/app`
(`BAO_TOKEN`, or the root token while `openbao-init.json` is still on the host).

## Building the app

The Firebase values of step 2–3 are build settings, not files in the repository:

```bash
cd apps/mobile
flutter build appbundle --release \
  --dart-define=HOTELLA_API=https://api.<domain> --dart-define=HOTELLA_APP_VERSION=1.0.0 \
  --dart-define=FIREBASE_PROJECT_ID=hotella-prod --dart-define=FIREBASE_SENDER_ID=<sender id> \
  --dart-define=FIREBASE_API_KEY=<web api key> --dart-define=FIREBASE_APP_ID=<android app id>
flutter build ipa --release …same, with FIREBASE_APP_ID=<ios app id>
```

The Firebase Web API key only identifies the project to Google (it is not a secret and grants nothing on its own);
restrict it to the Android/iOS apps in the Google Cloud console anyway. In Xcode, the Runner target needs the *Push
Notifications* capability and *Background Modes → Remote notifications*.

## How it behaves

- After sign-in the app asks for permission once and registers the phone (`POST /api/v1/me/devices`); it does so again
  at every start and when Firebase rotates the address. Signing out removes the phone (`DELETE /api/v1/me/devices/…`)
  and deletes its address, so the next person on the same phone never receives the previous person's work. Ending the
  session from the server (disabling the user, a revoked session) also revokes the phone.
- Every notification that goes to the in-app inbox also becomes a push (`PUSH` channel, priorities NORMAL and up). A
  person can switch pushes off per category (`PUT /api/v1/properties/{p}/notification-preferences`,
  `channel: PUSH`); critical escalations ignore that, as for e-mail.
- A phone Firebase no longer knows (app uninstalled) is revoked the first time a send reports it; other failures retry
  after 1, 2, 4 and 8 minutes.
- Tapping a push opens what it is about in the app: a task, the work behind an escalation, or a restaurant booking
  (new bookings from the guest app or the concierge are pushed to everyone who runs the restaurant board); anything
  else opens the inbox. The push itself only says "New task for you", "New restaurant booking"…, never the guest.
- Device acceptance (pilot checklist): sign in on a test phone as a restaurant host, book a table from the guest app,
  check the push arrives with the generic title, tap it, and seat the booking from the screen it opens.
- Checks: `ops.notification_deliveries` rows with `channel = 'PUSH'` — `SENT` with the Firebase message name,
  `SKIPPED` with `channel_not_configured` (no project) or `no_device`, `FAILED` after the retries.
