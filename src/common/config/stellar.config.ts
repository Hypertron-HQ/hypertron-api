import { registerAs } from '@nestjs/config';

export interface StellarConfig {
  testnetHorizonUrl: string;
  mainnetHorizonUrl: string;
  /** Public pool address (C…) — private settlement only; never classic dest */
  paymentPoolAddress: string;
  testnetDestinationAddress: string;
  mainnetDestinationAddress: string;
  /** Circle / issuer accounts for classic asset verification */
  usdcIssuerTestnet: string;
  usdcIssuerMainnet: string;
  eurcIssuerTestnet: string;
  eurcIssuerMainnet: string;
  /** Delay before finality-check job (ms). Default ~1 Stellar ledger. */
  finalityDelayMs: number;
  /** How many recent Horizon ops to scan per open payment. */
  reconcilerLookback: number;
}

/** Well-known Circle USDC issuers on Stellar. */
export const DEFAULT_USDC_ISSUER_TESTNET =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3MNLQUIL';
export const DEFAULT_USDC_ISSUER_MAINNET =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Circle EURC issuers on Stellar. */
export const DEFAULT_EURC_ISSUER_TESTNET =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3MNLQUIL';
export const DEFAULT_EURC_ISSUER_MAINNET =
  'GDHU6WRTMTRRCAXVSNHHSZKWNTAPDS75BOZPAV5P5W7QIT4QGC4O2NGS';

export default registerAs('stellar', (): StellarConfig => ({
  testnetHorizonUrl:
    process.env.STELLAR_TESTNET_HORIZON_URL ??
    'https://horizon-testnet.stellar.org',
  mainnetHorizonUrl:
    process.env.STELLAR_MAINNET_HORIZON_URL ?? 'https://horizon.stellar.org',
  paymentPoolAddress: process.env.PAYMENT_POOL_ADDRESS?.trim() ?? '',
  testnetDestinationAddress:
    process.env.STELLAR_TESTNET_DESTINATION_ADDRESS?.trim() ?? '',
  mainnetDestinationAddress:
    process.env.STELLAR_MAINNET_DESTINATION_ADDRESS?.trim() ?? '',
  usdcIssuerTestnet:
    process.env.STELLAR_USDC_ISSUER_TESTNET?.trim() ||
    DEFAULT_USDC_ISSUER_TESTNET,
  usdcIssuerMainnet:
    process.env.STELLAR_USDC_ISSUER_MAINNET?.trim() ||
    DEFAULT_USDC_ISSUER_MAINNET,
  eurcIssuerTestnet:
    process.env.STELLAR_EURC_ISSUER_TESTNET?.trim() ||
    DEFAULT_EURC_ISSUER_TESTNET,
  eurcIssuerMainnet:
    process.env.STELLAR_EURC_ISSUER_MAINNET?.trim() ||
    DEFAULT_EURC_ISSUER_MAINNET,
  finalityDelayMs: parseInt(
    process.env.STELLAR_FINALITY_DELAY_MS ?? '5000',
    10,
  ),
  reconcilerLookback: parseInt(
    process.env.STELLAR_RECONCILER_LOOKBACK ?? '50',
    10,
  ),
}));
