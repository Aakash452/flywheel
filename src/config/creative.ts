/**
 * Creative Engine tuning. `minVariants` is spec text ("Generate 30+
 * variants per experiment"); the rest govern the generate → filter →
 * top-up loop that gets there despite the diversity gate rejecting some
 * candidates along the way.
 */
export interface CreativeEngineConfig {
  /** Spec: "Generate 30+ variants per experiment." */
  minVariants: number;
  /** How many candidates to request per generation call. */
  variantsPerCall: number;
  /** How many generation rounds to attempt before giving up short of minVariants. */
  maxRounds: number;
}

export const creativeEngineConfig: CreativeEngineConfig = {
  minVariants: 30,
  variantsPerCall: 18,
  maxRounds: 4,
};
