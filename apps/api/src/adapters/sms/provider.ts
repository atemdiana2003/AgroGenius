export interface SmsProvider {
  send(input: { to: string; message: string }): Promise<{ status: 'SENT' | 'SIMULATED' }>;
}

export class SimulatedSmsProvider implements SmsProvider {
  async send(input: { to: string; message: string }) {
    void input;
    return { status: 'SIMULATED' as const };
  }
}

export class DisabledSmsProvider implements SmsProvider {
  async send(input: { to: string; message: string }) {
    void input;
    return { status: 'SIMULATED' as const };
  }
}
