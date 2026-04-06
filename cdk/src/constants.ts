export type CDKConfig = {
  env: string;
  aws: {
    account: string;
    region: string;
  };
  service?: string;
};
