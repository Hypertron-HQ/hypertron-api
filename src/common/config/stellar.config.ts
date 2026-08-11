import { registerAs } from '@nestjs/config';

export interface StellarConfig {
  testnetHorizonUrl: string;
  mainnetHorizonUrl: string;
  /** Public pool / receive address (C… or G…) — never a secret key */
  paymentPoolAddress: string;
  testnetDestinationAddress: string;
  mainnetDestinationAddress: string;
}

export default registerAs(
  'stellar',
  (): StellarConfig => ({
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
  }),
);
