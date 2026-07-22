/** API compatibility facade for the shared content-free macOS power probe. */
export {
  isPowerOkForLlm,
  parseOnAcPower,
  readMacAcPower as isOnAcPower
} from "@muse/macos/system-resource-observation";
