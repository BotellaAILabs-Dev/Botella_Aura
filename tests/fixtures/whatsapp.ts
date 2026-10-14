/** Shared WhatsApp webhook fixtures for the assistant's tests. */

export const SECRET = 'app-secret-for-tests';
export const PHONE_ID = '1111111111';

export function textWebhook(opts: {
  wamid?: string;
  from?: string;
  text?: string;
  name?: string;
  phoneNumberId?: string;
  timestamp?: number;
} = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: opts.phoneNumberId ?? PHONE_ID },
              contacts: [{ profile: { name: opts.name ?? 'Asha Rao' }, wa_id: opts.from ?? '919876543210' }],
              messages: [
                {
                  from: opts.from ?? '919876543210',
                  id: opts.wamid ?? 'wamid.IN1',
                  timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: opts.text ?? 'What time does ABC Store open?' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
