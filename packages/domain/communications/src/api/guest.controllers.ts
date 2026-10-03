import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import {
  CurrentGuest,
  GUEST_API,
  type GuestPrincipal,
  type GuestPublicApi,
  GuestSessionGuard,
  RequireGuestScope,
} from '@hotella/domain-guest/public';
import { Public } from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
import { CurrentLocale } from '@hotella/platform-i18n';
import { Inject } from '@nestjs/common';
import {
  ActivationService,
  completeSchema,
  handleSchema,
  qrVerifySchema,
  requestOtpSchema,
  startActivationSchema,
  verifyOtpSchema,
} from '../application/activation.service';
import { GuestPortalService } from '../application/guest-portal.service';
import { ConversationService } from '../application/conversation.service';
import { guestMessageSchema } from '../application/inbox.service';

class StartActivationDto extends createZodDto(startActivationSchema) {}
class RequestOtpDto extends createZodDto(requestOtpSchema) {}
class HandleDto extends createZodDto(handleSchema) {}
class VerifyOtpDto extends createZodDto(verifyOtpSchema) {}
class CompleteDto extends createZodDto(completeSchema) {}
class QrVerifyDto extends createZodDto(qrVerifySchema) {}
class GuestMessageDto extends createZodDto(guestMessageSchema) {}

/**
 * Passwordless guest activation (Spec §19–§20, ADR-0011): link or room QR → phone → OTP (WhatsApp, SMS fallback) →
 * grant + guest session. Public for the staff guard; every step is rate limited per IP, and the OTP itself is limited
 * per phone and per session.
 */
@Controller('guest')
@Public()
export class GuestActivationController {
  constructor(
    private readonly activation: ActivationService,
    private readonly locale: CurrentLocale,
  ) {}

  @Post('activation/start')
  @HttpCode(200)
  @RateLimit({ name: 'guest-activation-start', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  start(@Body() body: StartActivationDto) {
    return this.activation.start(body.token);
  }

  @Post('activation/otp/request')
  @HttpCode(200)
  @RateLimit({ name: 'guest-otp-request', limit: 10, windowSeconds: 600, keyBy: 'ip' })
  request(@Body() body: RequestOtpDto) {
    return this.activation.requestOtp(body, this.locale.get());
  }

  @Post('activation/otp/resend')
  @HttpCode(200)
  @RateLimit({ name: 'guest-otp-resend', limit: 10, windowSeconds: 600, keyBy: 'ip' })
  resend(@Body() body: HandleDto) {
    return this.activation.resend(body.handle);
  }

  @Post('activation/otp/verify')
  @HttpCode(200)
  @RateLimit({ name: 'guest-otp-verify', limit: 20, windowSeconds: 600, keyBy: 'ip' })
  verify(@Body() body: VerifyOtpDto) {
    return this.activation.verify(body.handle, body.code, body.device ?? null);
  }

  /** After front desk confirmed the guest in person (staff-assisted verification). */
  @Post('activation/complete')
  @HttpCode(200)
  @RateLimit({ name: 'guest-otp-complete', limit: 20, windowSeconds: 600, keyBy: 'ip' })
  complete(@Body() body: CompleteDto) {
    return this.activation.complete(body.handle, body.device ?? null);
  }

  @Get('qr/:token')
  @RateLimit({ name: 'guest-qr-resolve', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  resolveQr(@Param('token') token: string) {
    return this.activation.resolveQr(token);
  }

  @Post('qr/:token/verify')
  @HttpCode(200)
  @RateLimit({ name: 'guest-qr-verify', limit: 10, windowSeconds: 600, keyBy: 'ip' })
  verifyQr(@Param('token') token: string, @Body() body: QrVerifyDto) {
    return this.activation.checkQr(token, body.lastName);
  }
}

/** The activated guest's own view and sign-out. */
@Controller('guest')
@Public()
@UseGuards(GuestSessionGuard)
export class GuestSelfController {
  constructor(
    private readonly portal: GuestPortalService,
    private readonly locale: CurrentLocale,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
  ) {}

  @Get('me')
  me(@CurrentGuest() guest: GuestPrincipal) {
    return this.portal.me(guest, this.locale.get());
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentGuest() guest: GuestPrincipal) {
    await this.guests.revokeGuestSession(guest.tenantId, guest.sessionId, 'LOGOUT');
    return { signedOut: true };
  }
}

/** Chat on guest web (Spec §18): the same stay conversation as WhatsApp; needs the CHAT scope. */
@Controller('guest/conversation')
@Public()
@UseGuards(GuestSessionGuard)
@RequireGuestScope('CHAT')
export class GuestChatController {
  constructor(private readonly conversations: ConversationService) {}

  @Get()
  get(@CurrentGuest() guest: GuestPrincipal) {
    return this.conversations.guestConversation(guest);
  }

  @Post('messages')
  @RateLimit({ name: 'guest-chat', limit: 30, windowSeconds: 60 })
  post(@CurrentGuest() guest: GuestPrincipal, @Body() body: GuestMessageDto) {
    return this.conversations.guestPost(guest, body.body);
  }
}
