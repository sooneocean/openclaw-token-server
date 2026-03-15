import Stripe from 'stripe';
import { config } from '../config';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!config.stripeSecretKey) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(config.stripeSecretKey);
  }
  return stripeClient;
}

export function isStripeEnabled(): boolean {
  return !!config.stripeSecretKey;
}
