import { registerAs } from '@nestjs/config';

export interface StellarConfig {
  testnetHorizonUrl: string;
  mainnetHorizonUrl: string;
  testnetDestinationSecret: string;
  mainnetDestinationSecret: string;
}

export default registerAs(
  'stellar',
  (): StellarConfig => ({
    testnetHorizonUrl:
      process.env.STELLAR_TESTNET_HORIZON_URL ??
      'https://horizon-testnet.stellar.org',
    mainnetHorizonUrl:
      process.env.STELLAR_MAINNET_HORIZON_URL ??
      'https://horizon.stellar.org',
    testnetDestinationSecret:
      process.env.STELLAR_TESTNET_DESTINATION_SECRET ?? '',
    mainnetDestinationSecret:
      process.env.STELLAR_MAINNET_DESTINATION_SECRET ?? '',
  }),
);
