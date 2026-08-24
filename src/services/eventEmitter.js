import { EventEmitter } from 'events';

class PaymentEventEmitter extends EventEmitter {}

export const paymentEvents = new PaymentEventEmitter();
