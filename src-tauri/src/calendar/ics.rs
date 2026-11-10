//! Reading calendar invitations (RFC 5545 iCalendar) from email: the `text/calendar` part or
//! `.ics` attachment Google, Outlook and Apple send. Pure: no IO. Only what Mail's invite card
//! needs is kept: the method, UID, SEQUENCE, times (with `TZID`, all-day and floating), the
//! repeat lines, organizer, guests and their answers, place and the meeting link.

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;

/// One end of an invited event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IcsTime {
    /// A moment, in UTC ms, with the IANA zone it was given in (when Pheeme knows it).
    At { ms: i64, zone: Option<String> },
    /// A day, for all-day events.
    Day(NaiveDate),
}

impl IcsTime {
    pub fn ms(&self) -> Option<i64> {
        match self {
            IcsTime::At { ms, .. } => Some(*ms),
            IcsTime::Day(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcsPerson {
    pub email: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcsAttendee {
    pub email: String,
    pub name: Option<String>,
    /// As Google spells it: `needsAction`, `accepted`, `tentative` or `declined`.
    pub response: String,
    pub optional: bool,
    /// A room or other resource rather than a person.
    pub resource: bool,
}

/// The event an invitation is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    /// `REQUEST`, `CANCEL`, `REPLY`, `PUBLISH`, …; `REQUEST` when the file has none.
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    /// `CONFIRMED`, `TENTATIVE` or `CANCELLED`, when given.
    pub status: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start: IcsTime,
    pub end: IcsTime,
    /// RRULE, EXDATE and RDATE lines, as Google's `recurrence` takes them.
    pub recurrence: Vec<String>,
    /// For one changed occurrence of a series: the start it was originally at.
    pub recurrence_id: Option<IcsTime>,
    pub organizer: Option<IcsPerson>,
    pub attendees: Vec<IcsAttendee>,
    /// The video meeting link (Google Meet, Teams, Zoom, FaceTime, …).
    pub meeting_url: Option<String>,
}

impl Invite {
    pub fn all_day(&self) -> bool {
        matches!(self.start, IcsTime::Day(_))
    }

    /// The invitation was cancelled (the whole event, or this occurrence).
    pub fn cancelled(&self) -> bool {
        self.method == "CANCEL" || self.status.as_deref() == Some("CANCELLED")
    }
}

/// One content line: `NAME;PARAM=VALUE:value`, unfolded, name and parameter names uppercased.
#[derive(Debug, Clone)]
struct Line {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Line {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Unfold (a line starting with a space or tab continues the one before) and split.
fn lines(text: &str) -> Vec<Line> {
    let mut unfolded: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        match raw.as_bytes().first() {
            Some(b' ' | b'\t') if !unfolded.is_empty() => {
                if let Some(last) = unfolded.last_mut() {
                    last.push_str(&raw[1..]);
                }
            }
            _ if raw.trim().is_empty() => {}
            _ => unfolded.push(raw.to_owned()),
        }
    }
    unfolded.iter().filter_map(|l| parse_line(l)).collect()
}

/// Splits at the first `:` outside double quotes, then the parameters at `;` outside quotes.
fn parse_line(line: &str) -> Option<Line> {
    let mut quoted = false;
    let mut colon = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = Vec::new();
    let mut current = String::new();
    quoted = false;
    for c in head.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ';' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    parts.push(current);
    let mut parts = parts.into_iter();
    let name = parts.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(v);
            Some((k.trim().to_ascii_uppercase(), v.to_owned()))
        })
        .collect();
    Some(Line {
        name,
        params,
        value: value.to_owned(),
    })
}

/// TEXT values: `\n`, `\,`, `\;` and `\\` escapes.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn text(value: &str) -> Option<String> {
    let t = unescape(value).trim().to_owned();
    (!t.is_empty()).then_some(t)
}

/// The address in `mailto:a@b` (any case), or an `EMAIL=` parameter (Apple puts one there
/// when the value is a `urn:uuid:`).
fn address(line: &Line) -> Option<String> {
    if let Some(email) = line.param("EMAIL") {
        if email.contains('@') {
            return Some(email.trim().to_owned());
        }
    }
    let v = line.value.trim();
    let v = if v.len() >= 7 && v[..7].eq_ignore_ascii_case("mailto:") {
        &v[7..]
    } else {
        v
    };
    v.contains('@').then(|| v.trim().to_owned())
}

fn person(line: &Line) -> Option<IcsPerson> {
    Some(IcsPerson {
        email: address(line)?,
        name: line.param("CN").and_then(text).filter(|n| !n.contains('@')),
    })
}

fn attendee(line: &Line) -> Option<IcsAttendee> {
    let p = person(line)?;
    let response = match line
        .param("PARTSTAT")
        .unwrap_or("NEEDS-ACTION")
        .to_ascii_uppercase()
        .as_str()
    {
        "ACCEPTED" => "accepted",
        "TENTATIVE" => "tentative",
        "DECLINED" => "declined",
        _ => "needsAction",
    };
    let cutype = line.param("CUTYPE").unwrap_or("").to_ascii_uppercase();
    Some(IcsAttendee {
        email: p.email,
        name: p.name,
        response: response.to_owned(),
        optional: line
            .param("ROLE")
            .is_some_and(|r| r.eq_ignore_ascii_case("OPT-PARTICIPANT")),
        resource: cutype == "ROOM" || cutype == "RESOURCE",
    })
}

// ── Time zones ───────────────────────────────────────────────────────────────

/// Windows zone names (Outlook's `TZID`s) for the IANA zones they stand for.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time", "America/New_York"),
    ("US Eastern Standard Time", "America/Indiana/Indianapolis"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Buenos_Aires"),
    ("UTC", "UTC"),
    ("Coordinated Universal Time", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Nepal Standard Time", "Asia/Kathmandu"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
];

/// The IANA zone a `TZID` names: an IANA name itself, a Windows name, or a path ending in one
/// (`/mozilla.org/20050126_1/America/New_York`).
fn iana_zone(tzid: &str) -> Option<Tz> {
    let tzid = tzid.trim();
    if let Ok(tz) = tzid.parse::<Tz>() {
        return Some(tz);
    }
    if let Some((_, iana)) = WINDOWS_ZONES
        .iter()
        .find(|(w, _)| w.eq_ignore_ascii_case(tzid))
    {
        return iana.parse().ok();
    }
    // A path: try each tail ("a/b/America/New_York" → "America/New_York").
    let parts: Vec<&str> = tzid.split('/').collect();
    (1..parts.len()).find_map(|i| parts[i..].join("/").parse().ok())
}

/// A `VTIMEZONE` observance (`STANDARD` or `DAYLIGHT`): from its start, local times are
/// `offset` seconds east of UTC, again each year when it has a yearly rule.
#[derive(Debug, Clone)]
struct Observance {
    start: NaiveDateTime,
    offset: i32,
    /// `(month, nth weekday)`: `BYMONTH` and `BYDAY` of a yearly rule (`-1` is the last).
    yearly: Option<(u32, i32, Weekday)>,
}

#[derive(Debug, Clone, Default)]
struct VTimezone {
    observances: Vec<Observance>,
}

fn parse_offset(v: &str) -> Option<i32> {
    let v = v.trim();
    let (sign, rest) = match v.as_bytes().first()? {
        b'+' => (1, &v[1..]),
        b'-' => (-1, &v[1..]),
        _ => (1, v),
    };
    if rest.len() < 4 {
        return None;
    }
    let h: i32 = rest[..2].parse().ok()?;
    let m: i32 = rest[2..4].parse().ok()?;
    let s: i32 = rest.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(sign * (h * 3600 + m * 60 + s))
}

fn weekday(code: &str) -> Option<Weekday> {
    Some(match code {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// `FREQ=YEARLY;BYMONTH=3;BYDAY=2SU` → `(3, 2, Sun)`.
fn yearly_rule(rule: &str) -> Option<(u32, i32, Weekday)> {
    let mut month = None;
    let mut day = None;
    for part in rule.split(';') {
        let (k, v) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" if !v.eq_ignore_ascii_case("YEARLY") => return None,
            "BYMONTH" => month = v.parse().ok(),
            "BYDAY" => {
                let v = v.to_ascii_uppercase();
                let split = v.len().checked_sub(2)?;
                let n: i32 = match &v[..split] {
                    "" => 1,
                    n => n.trim_start_matches('+').parse().ok()?,
                };
                day = Some((n, weekday(&v[split..])?));
            }
            _ => {}
        }
    }
    let (n, wd) = day?;
    Some((month?, n, wd))
}

/// The `n`th `wd` of `month` (negative: from the end).
fn nth_weekday(year: i32, month: u32, n: i32, wd: Weekday) -> Option<NaiveDate> {
    if n > 0 {
        let first = NaiveDate::from_ymd_opt(year, month, 1)?;
        let shift = (7 + wd.num_days_from_monday() - first.weekday().num_days_from_monday()) % 7;
        first.checked_add_signed(Duration::days(i64::from(shift) + 7 * i64::from(n - 1)))
    } else {
        let next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)?
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)?
        };
        let last = next.pred_opt()?;
        let shift = (7 + last.weekday().num_days_from_monday() - wd.num_days_from_monday()) % 7;
        last.checked_sub_signed(Duration::days(i64::from(shift) + 7 * i64::from(-n - 1)))
    }
}

impl VTimezone {
    /// The offset in force at local time `t`: the latest observance onset at or before it.
    fn offset_at(&self, t: NaiveDateTime) -> Option<i32> {
        let mut best: Option<(NaiveDateTime, i32)> = None;
        for o in &self.observances {
            let onsets: Vec<NaiveDateTime> = match o.yearly {
                Some((month, n, wd)) => [t.year() - 1, t.year()]
                    .iter()
                    .filter_map(|&y| nth_weekday(y, month, n, wd))
                    .map(|d| d.and_time(o.start.time()))
                    .filter(|d| *d >= o.start)
                    .collect(),
                None => vec![o.start],
            };
            for onset in onsets.into_iter().filter(|d| *d <= t) {
                if best.is_none_or(|(b, _)| onset > b) {
                    best = Some((onset, o.offset));
                }
            }
        }
        best.map(|(_, off)| off)
            .or_else(|| self.observances.first().map(|o| o.offset))
    }
}

/// How local times in the file are read.
struct Zones<'a> {
    defined: &'a [(String, VTimezone)],
    /// For floating times (no zone at all): `X-WR-TIMEZONE`, else the reader's zone.
    floating: Option<Tz>,
}

impl Zones<'_> {
    /// UTC ms and IANA name of local time `t` in zone `tzid`.
    fn resolve(&self, t: NaiveDateTime, tzid: Option<&str>) -> Option<(i64, Option<String>)> {
        let zone = tzid
            .and_then(iana_zone)
            .or(if tzid.is_none() { self.floating } else { None });
        if let Some(tz) = zone {
            let at = tz
                .from_local_datetime(&t)
                .earliest()
                // A time skipped by daylight saving: an hour later is the same instant.
                .or_else(|| tz.from_local_datetime(&(t + Duration::hours(1))).earliest())?;
            return Some((at.timestamp_millis(), Some(tz.name().to_owned())));
        }
        // An unknown name: its VTIMEZONE's offsets, else UTC.
        let offset = tzid
            .and_then(|id| self.defined.iter().find(|(name, _)| name == id))
            .and_then(|(_, vtz)| vtz.offset_at(t))
            .unwrap_or(0);
        let utc = t - Duration::seconds(i64::from(offset));
        Some((Utc.from_utc_datetime(&utc).timestamp_millis(), None))
    }

    fn time(&self, line: &Line) -> Option<IcsTime> {
        let v = line.value.trim();
        let is_date = line
            .param("VALUE")
            .is_some_and(|x| x.eq_ignore_ascii_case("DATE"))
            || (v.len() == 8 && v.bytes().all(|b| b.is_ascii_digit()));
        if is_date {
            return NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d")
                .ok()
                .map(IcsTime::Day);
        }
        if let Some(utc) = v.strip_suffix('Z').or_else(|| v.strip_suffix('z')) {
            let t = parse_local(utc)?;
            return Some(IcsTime::At {
                ms: Utc.from_utc_datetime(&t).timestamp_millis(),
                zone: line
                    .param("TZID")
                    .and_then(iana_zone)
                    .map(|z| z.name().to_owned()),
            });
        }
        let (ms, zone) = self.resolve(parse_local(v)?, line.param("TZID"))?;
        Some(IcsTime::At { ms, zone })
    }
}

fn parse_local(v: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M"))
        .ok()
}

/// `P1DT2H30M`, `PT45M`, `P1W` (a leading `-` is ignored: an end never comes first).
fn parse_duration(v: &str) -> Option<Duration> {
    let v = v.trim().trim_start_matches(['+', '-']);
    let v = v.strip_prefix('P').or_else(|| v.strip_prefix('p'))?;
    let mut total = Duration::zero();
    let mut number = String::new();
    let mut in_time = false;
    for c in v.chars() {
        match c.to_ascii_uppercase() {
            'T' => in_time = true,
            d if d.is_ascii_digit() => number.push(d),
            unit => {
                let n: i64 = std::mem::take(&mut number).parse().ok()?;
                total += match (unit, in_time) {
                    ('W', false) => Duration::weeks(n),
                    ('D', false) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(total)
}

// ── Meeting links ────────────────────────────────────────────────────────────

/// Hosts whose links are video meetings.
const MEETING_HOSTS: &[&str] = &[
    "meet.google.com",
    "teams.microsoft.com",
    "teams.live.com",
    "zoom.us",
    "zoom.com",
    "facetime.apple.com",
    "webex.com",
    "whereby.com",
    "gotomeeting.com",
];

fn is_meeting_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    MEETING_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// The first meeting link in free text (a description or location).
fn meeting_url_in(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find("http") {
        let tail = &rest[at..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | ')' | ']'))
            .unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches(['.', ',', ';']);
        if is_meeting_url(url) {
            return Some(url.to_owned());
        }
        rest = &tail[4..];
    }
    None
}

// ── The file ─────────────────────────────────────────────────────────────────

/// Reads the invitation in an iCalendar file. A file with several events for one UID (a
/// series and its changed occurrences) gives the series; one with only changed occurrences
/// gives the first. `None` when there is no event with a UID and a start.
///
/// `floating`: the zone for times written without one (the reader's Calendar zone).
pub fn parse(text: &str, floating: Option<Tz>) -> Option<Invite> {
    let all = lines(text);
    let mut method = None;
    let mut calendar_zone = None;
    let mut zones: Vec<(String, VTimezone)> = Vec::new();
    let mut events: Vec<Vec<Line>> = Vec::new();

    // Components: VCALENDAR > VTIMEZONE (> STANDARD | DAYLIGHT), VEVENT (> VALARM).
    let mut stack: Vec<String> = Vec::new();
    let mut zone: Option<(String, VTimezone)> = None;
    let mut observance: Vec<Line> = Vec::new();
    for line in all {
        match line.name.as_str() {
            "BEGIN" => {
                let what = line.value.trim().to_ascii_uppercase();
                match what.as_str() {
                    "VEVENT" if stack.last().map(String::as_str) == Some("VCALENDAR") => {
                        events.push(Vec::new());
                    }
                    "VTIMEZONE" => zone = Some((String::new(), VTimezone::default())),
                    "STANDARD" | "DAYLIGHT" => observance.clear(),
                    _ => {}
                }
                stack.push(what);
                continue;
            }
            "END" => {
                match stack.pop().as_deref() {
                    Some("VTIMEZONE") => zones.extend(zone.take()),
                    Some("STANDARD" | "DAYLIGHT") => {
                        if let Some((_, vtz)) = zone.as_mut() {
                            vtz.observances.extend(observance_of(&observance));
                        }
                    }
                    _ => {}
                }
                continue;
            }
            _ => {}
        }
        match stack.last().map(String::as_str) {
            Some("VCALENDAR") => match line.name.as_str() {
                "METHOD" => method = Some(line.value.trim().to_ascii_uppercase()),
                "X-WR-TIMEZONE" => calendar_zone = iana_zone(&line.value),
                _ => {}
            },
            Some("VTIMEZONE") if line.name == "TZID" => {
                if let Some((id, _)) = zone.as_mut() {
                    *id = line.value.trim().to_owned();
                }
            }
            Some("STANDARD" | "DAYLIGHT") => observance.push(line),
            Some("VEVENT") => {
                if let Some(event) = events.last_mut() {
                    event.push(line);
                }
            }
            _ => {}
        }
    }

    let zones = Zones {
        defined: &zones,
        floating: calendar_zone.or(floating),
    };
    let has = |e: &Vec<Line>, name: &str| e.iter().any(|l| l.name == name);
    let chosen = events
        .iter()
        .filter(|e| has(e, "UID") && has(e, "DTSTART"))
        .min_by_key(|e| has(e, "RECURRENCE-ID"))?;
    event_of(chosen, method.unwrap_or_else(|| "REQUEST".into()), &zones)
}

fn observance_of(lines: &[Line]) -> Option<Observance> {
    let get = |name: &str| lines.iter().find(|l| l.name == name);
    Some(Observance {
        start: parse_local(get("DTSTART")?.value.trim())?,
        offset: parse_offset(&get("TZOFFSETTO")?.value)?,
        yearly: get("RRULE").and_then(|l| yearly_rule(l.value.trim())),
    })
}

fn event_of(lines: &[Line], method: String, zones: &Zones) -> Option<Invite> {
    let get = |name: &str| lines.iter().find(|l| l.name == name);
    let start = zones.time(get("DTSTART")?)?;
    let end = get("DTEND")
        .and_then(|l| zones.time(l))
        .or_else(|| {
            let d = parse_duration(&get("DURATION")?.value)?;
            Some(match &start {
                IcsTime::At { ms, zone } => IcsTime::At {
                    ms: ms + d.num_milliseconds(),
                    zone: zone.clone(),
                },
                IcsTime::Day(day) => IcsTime::Day(*day + Duration::days(d.num_days().max(1))),
            })
        })
        // RFC 5545: no end is a one-day event for a date, an instant for a time.
        .unwrap_or_else(|| match &start {
            IcsTime::Day(d) => IcsTime::Day(*d + Duration::days(1)),
            at => at.clone(),
        });
    let recurrence = lines
        .iter()
        .filter(|l| matches!(l.name.as_str(), "RRULE" | "EXDATE" | "RDATE"))
        .map(recurrence_line)
        .collect();
    let organizer = get("ORGANIZER").and_then(person);
    let summary = get("SUMMARY").and_then(|l| text(&l.value));
    let description = get("DESCRIPTION").and_then(|l| text(&l.value));
    let location = get("LOCATION").and_then(|l| text(&l.value));
    let meeting_url = [
        "X-GOOGLE-CONFERENCE",
        "CONFERENCE",
        "X-MICROSOFT-SKYPETEAMSMEETINGURL",
        "URL",
    ]
    .iter()
    .filter_map(|name| get(name))
    .map(|l| unescape(l.value.trim()))
    .find(|u| is_meeting_url(u))
    .or_else(|| location.as_deref().and_then(meeting_url_in))
    .or_else(|| description.as_deref().and_then(meeting_url_in));
    Some(Invite {
        method,
        uid: unescape(get("UID")?.value.trim()),
        sequence: get("SEQUENCE")
            .and_then(|l| l.value.trim().parse().ok())
            .unwrap_or(0),
        status: get("STATUS").map(|l| l.value.trim().to_ascii_uppercase()),
        summary,
        description,
        location,
        start,
        end,
        recurrence,
        recurrence_id: get("RECURRENCE-ID").and_then(|l| zones.time(l)),
        organizer,
        attendees: lines
            .iter()
            .filter(|l| l.name == "ATTENDEE")
            .filter_map(attendee)
            .collect(),
        meeting_url,
    })
}

/// A repeat line as Google takes it: `RRULE:…` as written; EXDATE/RDATE with their `TZID`
/// (an Outlook name becomes its IANA one) or `VALUE=DATE`.
fn recurrence_line(l: &Line) -> String {
    let mut out = l.name.clone();
    for (k, v) in &l.params {
        let v = match k.as_str() {
            "TZID" => iana_zone(v).map_or_else(|| v.clone(), |tz| tz.name().to_owned()),
            "VALUE" => v.clone(),
            _ => continue,
        };
        out.push_str(&format!(";{k}={v}"));
    }
    out.push(':');
    out.push_str(l.value.trim());
    out
}

/// UTC ms as RFC 3339, for Google's `dateTime`.
pub fn rfc3339(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Midnight UTC of `day`, as the calendar cache stores all-day starts.
pub fn day_ms(day: NaiveDate) -> i64 {
    Utc.from_utc_datetime(&day.and_time(NaiveTime::MIN))
        .timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/src/calendar/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(path).unwrap()
    }

    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    fn at(s: &str, zone: Option<&str>) -> IcsTime {
        IcsTime::At {
            ms: ms(s),
            zone: zone.map(str::to_owned),
        }
    }

    #[test]
    fn google_invite() {
        let i = parse(&fixture("google-request.ics"), None).unwrap();
        assert_eq!(i.method, "REQUEST");
        assert_eq!(i.uid, "5k2l9m3n4o5p6q7r8s9t0u1v2w@google.com");
        assert_eq!(i.sequence, 0);
        assert_eq!(i.status.as_deref(), Some("CONFIRMED"));
        assert_eq!(i.summary.as_deref(), Some("Design review"));
        assert_eq!(i.start, at("2026-11-12T19:00:00Z", None));
        assert_eq!(i.end, at("2026-11-12T20:00:00Z", None));
        assert!(!i.all_day());
        assert!(!i.cancelled());
        assert_eq!(
            i.organizer,
            Some(IcsPerson {
                email: "morgan@example.org".into(),
                name: Some("Morgan Lee".into())
            })
        );
        assert_eq!(i.attendees.len(), 4);
        let me = i
            .attendees
            .iter()
            .find(|a| a.email == "avery@example.org")
            .unwrap();
        assert_eq!(me.response, "needsAction");
        assert_eq!(me.name, None, "a CN that is the address isn't a name");
        let opt = i
            .attendees
            .iter()
            .find(|a| a.email == "sam@example.com")
            .unwrap();
        assert!(opt.optional);
        assert_eq!(opt.response, "tentative");
        assert!(i.attendees.iter().any(|a| a.resource));
        assert_eq!(
            i.meeting_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(
            i.description.as_deref().map(|d| d.lines().next().unwrap()),
            Some("Walk through the new onboarding flow, then decide on the copy.")
        );
        assert_eq!(i.location.as_deref(), Some("Room 4, Studio; 2nd floor"));
    }

    #[test]
    fn outlook_invite_with_windows_zone() {
        let i = parse(&fixture("outlook-request.ics"), None).unwrap();
        assert_eq!(i.method, "REQUEST");
        assert_eq!(i.sequence, 0);
        assert_eq!(i.summary.as_deref(), Some("Quarterly planning"));
        // 10:00 Pacific in November is 18:00 UTC.
        assert_eq!(
            i.start,
            at("2026-11-17T18:00:00Z", Some("America/Los_Angeles"))
        );
        assert_eq!(
            i.end,
            at("2026-11-17T19:30:00Z", Some("America/Los_Angeles"))
        );
        assert_eq!(
            i.organizer.as_ref().map(|o| o.email.as_str()),
            Some("jordan@contoso.com")
        );
        assert_eq!(
            i.meeting_url.as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0")
        );
        assert_eq!(i.attendees[0].name.as_deref(), Some("Avery Quinn"));
    }

    #[test]
    fn apple_invite_with_iana_zone() {
        let i = parse(&fixture("apple-request.ics"), None).unwrap();
        assert_eq!(i.method, "REQUEST");
        assert_eq!(i.uid, "8E3C1A6F-4B2D-4C1E-9F7A-2D5B6C7E8F90");
        assert_eq!(i.sequence, 1);
        // 19:30 in Paris (winter, UTC+1).
        assert_eq!(i.start, at("2026-11-20T18:30:00Z", Some("Europe/Paris")));
        assert_eq!(i.end, at("2026-11-20T21:00:00Z", Some("Europe/Paris")));
        assert_eq!(i.summary.as_deref(), Some("Dinner at Chez Léon"));
        assert_eq!(
            i.attendees
                .iter()
                .map(|a| a.email.as_str())
                .collect::<Vec<_>>(),
            vec!["camille@icloud.com", "avery@example.com"],
            "EMAIL= wins over a urn:uuid value"
        );
        assert_eq!(
            i.meeting_url.as_deref(),
            Some("https://facetime.apple.com/join#v=1&p=AbCdEf&k=XyZ")
        );
    }

    #[test]
    fn google_cancellation() {
        let i = parse(&fixture("google-cancel.ics"), None).unwrap();
        assert_eq!(i.method, "CANCEL");
        assert_eq!(i.status.as_deref(), Some("CANCELLED"));
        assert!(i.cancelled());
        assert_eq!(i.sequence, 2);
    }

    #[test]
    fn google_update_is_a_later_sequence() {
        let first = parse(&fixture("google-request.ics"), None).unwrap();
        let update = parse(&fixture("google-update.ics"), None).unwrap();
        assert_eq!(update.uid, first.uid);
        assert!(update.sequence > first.sequence);
        assert_eq!(update.start, at("2026-11-12T20:30:00Z", None));
        assert!(!update.cancelled());
    }

    #[test]
    fn reply_carries_the_guests_answer() {
        let i = parse(&fixture("google-reply.ics"), None).unwrap();
        assert_eq!(i.method, "REPLY");
        assert_eq!(i.attendees.len(), 1);
        assert_eq!(i.attendees[0].response, "accepted");
        assert_eq!(i.attendees[0].email, "dana@example.com");
    }

    #[test]
    fn all_day_event() {
        let i = parse(&fixture("all-day.ics"), None).unwrap();
        assert!(i.all_day());
        assert_eq!(i.method, "PUBLISH");
        assert_eq!(
            i.start,
            IcsTime::Day(NaiveDate::from_ymd_opt(2026, 12, 24).unwrap())
        );
        assert_eq!(
            i.end,
            IcsTime::Day(NaiveDate::from_ymd_opt(2026, 12, 27).unwrap())
        );
    }

    #[test]
    fn recurring_series_with_exception() {
        let i = parse(&fixture("google-recurring.ics"), None).unwrap();
        assert_eq!(
            i.recurrence_id, None,
            "the series, not its changed occurrence"
        );
        assert_eq!(i.summary.as_deref(), Some("Weekly sync"));
        assert_eq!(
            i.recurrence,
            vec![
                "RRULE:FREQ=WEEKLY;WKST=SU;COUNT=10;BYDAY=TU".to_owned(),
                "EXDATE;TZID=America/New_York:20261124T100000".to_owned(),
            ]
        );
        assert_eq!(
            i.start,
            at("2026-11-17T15:00:00Z", Some("America/New_York"))
        );
    }

    #[test]
    fn one_changed_occurrence() {
        let i = parse(&fixture("outlook-occurrence.ics"), None).unwrap();
        assert_eq!(
            i.recurrence_id,
            Some(at("2026-12-01T15:00:00Z", Some("America/New_York")))
        );
        assert_eq!(
            i.start,
            at("2026-12-01T16:00:00Z", Some("America/New_York"))
        );
    }

    #[test]
    fn unknown_zone_uses_its_vtimezone() {
        // An old Outlook TZID with its own rules: daylight time in July (UTC-4).
        let i = parse(&fixture("outlook-custom-zone.ics"), None).unwrap();
        assert_eq!(i.start, at("2026-07-08T13:00:00Z", None));
        // …and standard time in January (UTC-5), from the same rules.
        let winter = fixture("outlook-custom-zone.ics")
            .replace("20260708T090000", "20270113T090000")
            .replace("20260708T100000", "20270113T100000");
        let i = parse(&winter, None).unwrap();
        assert_eq!(i.start, at("2027-01-13T14:00:00Z", None));
    }

    #[test]
    fn floating_times_use_the_readers_zone() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261112T090000\r\nDURATION:PT45M\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let i = parse(ics, Some(chrono_tz::Asia::Tokyo)).unwrap();
        assert_eq!(i.start, at("2026-11-12T00:00:00Z", Some("Asia/Tokyo")));
        assert_eq!(i.end, at("2026-11-12T00:45:00Z", Some("Asia/Tokyo")));
        assert_eq!(i.method, "REQUEST", "no METHOD reads as a request");
        let i = parse(ics, None).unwrap();
        assert_eq!(i.start, at("2026-11-12T09:00:00Z", None));
    }

    #[test]
    fn rejects_files_without_an_event() {
        assert!(parse("", None).is_none());
        assert!(parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", None).is_none());
        let todo = "BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t\nDTSTART:20261112T090000Z\nEND:VTODO\nEND:VCALENDAR\n";
        assert!(parse(todo, None).is_none());
    }

    #[test]
    fn lines_unfold_and_unescape() {
        let ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20261112T090000Z\nSUMMARY:One\\, two\\; three\n  four\nDESCRIPTION;LANGUAGE=en:a\\nb\\\\c\nEND:VEVENT\nEND:VCALENDAR\n";
        let i = parse(ics, None).unwrap();
        assert_eq!(i.summary.as_deref(), Some("One, two; three four"));
        assert_eq!(i.description.as_deref(), Some("a\nb\\c"));
    }

    #[test]
    fn durations_and_offsets() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(parse_duration("P2W"), Some(Duration::weeks(2)));
        assert_eq!(parse_duration("1H"), None);
        assert_eq!(parse_offset("-0500"), Some(-5 * 3600));
        assert_eq!(parse_offset("+0530"), Some(5 * 3600 + 1800));
        assert_eq!(
            nth_weekday(2026, 3, 2, Weekday::Sun),
            NaiveDate::from_ymd_opt(2026, 3, 8)
        );
        assert_eq!(
            nth_weekday(2026, 10, -1, Weekday::Sun),
            NaiveDate::from_ymd_opt(2026, 10, 25)
        );
        assert_eq!(
            iana_zone("/mozilla.org/20050126_1/America/New_York").map(|z| z.name()),
            Some("America/New_York")
        );
    }

    #[test]
    fn meeting_links_in_text() {
        assert_eq!(
            meeting_url_in("Join: <https://us02web.zoom.us/j/123?pwd=x>."),
            Some("https://us02web.zoom.us/j/123?pwd=x".into())
        );
        assert_eq!(meeting_url_in("See https://example.com/agenda"), None);
        assert!(!is_meeting_url("https://meet.google.com.evil.example/x"));
    }
}
