import XCTest
@testable import MuseDesktopCore

final class CalendarEnvTests: XCTestCase {
    func testEmptyInputYieldsNoEnv() {
        // only the implicit "local" provider ⇒ no providers var, no creds
        XCTAssertEqual(CalendarEnv.build(CalendarEnvInput()), [:])
    }

    func testMacOSOnlyListsLocalAndMacos() {
        let e = CalendarEnv.build(CalendarEnvInput(enableMacOS: true))
        XCTAssertEqual(e["MUSE_CALENDAR_PROVIDERS"], "local,macos")
        XCTAssertEqual(e.count, 1)
    }

    func testCalDavRequiresAllThreeFields() {
        // url + username but no password ⇒ NOT ready ⇒ nothing
        let partial = CalendarEnv.build(CalendarEnvInput(caldavURL: "https://dav", caldavUsername: "u"))
        XCTAssertEqual(partial, [:])
    }

    func testCalDavFullSetsCredsAndProvider() {
        let e = CalendarEnv.build(CalendarEnvInput(caldavURL: "  https://dav  ", caldavUsername: "u", caldavPassword: "p"))
        XCTAssertEqual(e["MUSE_CALDAV_URL"], "https://dav") // trimmed
        XCTAssertEqual(e["MUSE_CALDAV_USERNAME"], "u")
        XCTAssertEqual(e["MUSE_CALDAV_APP_PASSWORD"], "p")
        XCTAssertEqual(e["MUSE_CALENDAR_PROVIDERS"], "local,caldav")
    }

    func testGcalFullSetsCredsAndOptionalCalendarId() {
        let base = CalendarEnv.build(CalendarEnvInput(gcalClientId: "id", gcalClientSecret: "sec", gcalRefreshToken: "rt"))
        XCTAssertEqual(base["MUSE_GCAL_CLIENT_ID"], "id")
        XCTAssertEqual(base["MUSE_GCAL_REFRESH_TOKEN"], "rt")
        XCTAssertNil(base["MUSE_GCAL_CALENDAR_ID"]) // omitted when blank
        XCTAssertEqual(base["MUSE_CALENDAR_PROVIDERS"], "local,gcal")

        let withCal = CalendarEnv.build(CalendarEnvInput(gcalClientId: "id", gcalClientSecret: "sec", gcalRefreshToken: "rt", gcalCalendarId: "cal@x"))
        XCTAssertEqual(withCal["MUSE_GCAL_CALENDAR_ID"], "cal@x")
    }

    func testGcalPartialSetsNothing() {
        XCTAssertEqual(CalendarEnv.build(CalendarEnvInput(gcalClientId: "id", gcalClientSecret: "sec")), [:])
    }

    func testAllProvidersListedInOrder() {
        let e = CalendarEnv.build(CalendarEnvInput(
            enableMacOS: true,
            caldavURL: "u", caldavUsername: "n", caldavPassword: "p",
            gcalClientId: "i", gcalClientSecret: "s", gcalRefreshToken: "r"
        ))
        XCTAssertEqual(e["MUSE_CALENDAR_PROVIDERS"], "local,macos,caldav,gcal")
    }

    func testProvidersDoNotCrossWires() {
        // gcal-only must not set any CalDAV var
        let e = CalendarEnv.build(CalendarEnvInput(gcalClientId: "i", gcalClientSecret: "s", gcalRefreshToken: "r"))
        XCTAssertNil(e["MUSE_CALDAV_URL"])
    }
}
