/** API compatibility facade for the shared content-free macOS HID-idle probe. */
export {
  isOsIdleEnough,
  parseHidIdleSeconds,
  readMacIdleMs as osIdleMs
} from "@muse/macos/system-resource-observation";
