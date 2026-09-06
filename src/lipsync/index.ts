export {
  LIPSYNC_MESSAGE_TYPE,
  parseLipsyncData,
  type LipsyncBatch,
  type LipsyncEvent,
  type LipsyncEventKind,
  type LipsyncKeyframe,
} from "./protocol";

export {
  LipsyncFeed,
  REST_POSE,
  SCHEDULING_LEAD_SEC,
  type ArticulationSample,
  type LipsyncFeedOptions,
  type FeedStats,
  type LoggedEvent,
} from "./feed";

export {
  DEFAULT_ANCHORS,
  DEFAULT_MAPPER_CONFIG,
  DEFAULT_SMOOTHING,
  mapToVisemes,
  VisemeSmoother,
  ZERO_VISEMES,
  type SmoothingConfig,
  type VisemeMapperConfig,
  type VisemeWeights,
  type VowelAnchor,
} from "./visemeMapper";

export {
  ArticulationSource,
  DEFAULT_EVENT_HOLD_SEC,
  isLipsyncSource,
  type LipsyncSource,
} from "./source";
