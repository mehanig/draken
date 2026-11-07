export class VoicePeer {
  constructor(options?: { onClose?: (reason: string) => void; onEvent?: (event: Record<string, any>) => void });
  readonly closed: boolean;
  readonly inputActive: boolean;
  readonly clock: number;
  readonly audioState: AudioContextState;
  readonly level: number;
  open(input: MediaStream, negotiate: (offer: string, signal: AbortSignal) => Promise<string>): Promise<void>;
  muteOutput(muted: boolean): void;
  gateInput(enabled: boolean): void;
  stopInput(): void;
  replaceInput(stream: MediaStream): Promise<void>;
  resume(): Promise<void>;
  close(reason?: string): void;
}
