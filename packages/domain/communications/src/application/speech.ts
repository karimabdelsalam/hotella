import { Injectable } from '@nestjs/common';
import type { SpeechPort, SpeechServices } from '../public';

/** Holds the speech implementation another context registered (the AI context's Model Gateway). */
@Injectable()
export class SpeechRegistry implements SpeechServices {
  private port: SpeechPort | null = null;

  register(port: SpeechPort): void {
    if (this.port && this.port !== port) throw new Error('Speech services registered twice');
    this.port = port;
  }

  current(): SpeechPort | null {
    return this.port;
  }
}
