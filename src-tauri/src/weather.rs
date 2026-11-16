//! Weather for Calendar mode, off until Settings › Calendar turns it on: daily and hourly forecasts and
//! place search from Open-Meteo (free, no key, data under CC BY 4.0). A request carries a place
//! name or a latitude and longitude, nothing else. Answers are kept in memory: forecasts for an
//! hour, places found for an event's location for the session.

use crate::lock::lock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const SEARCH_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
/// Open-Meteo's longest forecast.
const FORECAST_DAYS: u32 = 16;
const FORECAST_TTL: Duration = Duration::from_secs(60 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);
/// The most parts of an event's location searched for a town.
const MAX_LOCATION_QUERIES: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum WeatherError {
    #[error("Pheeme couldn't reach the weather service.")]
    Network,
    #[error("The weather service didn't answer as expected ({0}).")]
    Unavailable(String),
}

impl WeatherError {
    pub fn code(&self) -> &str {
        match self {
            WeatherError::Network => "network",
            WeatherError::Unavailable(_) => "weather_unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemperatureUnit {
    Celsius,
    Fahrenheit,
}

/// A town or city the forecast is for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    /// State, province or region.
    pub region: Option<String>,
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    /// The place's IANA time zone, which the forecast's dates are in.
    pub time_zone: Option<String>,
}

/// One day's forecast; `date` is `YYYY-MM-DD` in the place's time zone.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayForecast {
    pub date: String,
    /// The WMO weather code (0 clear … 99 thunderstorm with hail).
    pub code: u8,
    pub high: f64,
    pub low: f64,
}

/// One hour's forecast; `at` is the hour's start as UTC milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourForecast {
    pub at: i64,
    /// The WMO weather code.
    pub code: u8,
    /// Rain, showers and snow in the hour, in millimetres.
    pub precipitation: f64,
    /// Whether the sun is up.
    pub is_day: bool,
}

/// A place's forecast: by day, and by hour for the same days.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub days: Vec<DayForecast>,
    pub hours: Vec<HourForecast>,
}

/// The forecast for an event's location.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationForecast {
    pub place: Place,
    pub days: Vec<DayForecast>,
}

/// One search result as Open-Meteo's geocoding API sends it.
#[derive(Debug, Clone, Deserialize)]
struct Found {
    name: String,
    latitude: f64,
    longitude: f64,
    feature_code: Option<String>,
    country_code: Option<String>,
    country: Option<String>,
    admin1: Option<String>,
    timezone: Option<String>,
}

impl From<Found> for Place {
    fn from(f: Found) -> Self {
        Place {
            name: f.name,
            region: f.admin1,
            country: f.country,
            latitude: f.latitude,
            longitude: f.longitude,
            time_zone: f.timezone,
        }
    }
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<Found>,
}

#[derive(Deserialize)]
struct ForecastResponse {
    /// The IANA zone the times are in (`timezone=auto` picks the place's).
    #[serde(default)]
    timezone: String,
    /// The zone's offset now, for a zone chrono-tz doesn't know.
    #[serde(default)]
    utc_offset_seconds: i32,
    daily: Daily,
    hourly: Hourly,
}

#[derive(Deserialize)]
struct Daily {
    time: Vec<String>,
    weather_code: Vec<Option<u8>>,
    temperature_2m_max: Vec<Option<f64>>,
    temperature_2m_min: Vec<Option<f64>>,
}

#[derive(Deserialize)]
struct Hourly {
    /// Local wall time, `YYYY-MM-DDTHH:MM`.
    time: Vec<String>,
    weather_code: Vec<Option<u8>>,
    precipitation: Vec<Option<f64>>,
    is_day: Vec<Option<u8>>,
}

/// A forecast and when it was read.
type CachedForecast = (Instant, Arc<Forecast>);

pub struct WeatherService {
    http: reqwest::Client,
    forecasts: Mutex<HashMap<(String, TemperatureUnit), CachedForecast>>,
    locations: Mutex<HashMap<String, Option<Place>>>,
}

impl Default for WeatherService {
    fn default() -> Self {
        Self::new()
    }
}

impl WeatherService {
    pub fn new() -> Self {
        let http = crate::http::client_builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client builds");
        Self {
            http,
            forecasts: Mutex::default(),
            locations: Mutex::default(),
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        query: &[(&str, String)],
    ) -> Result<T, WeatherError> {
        let response = self
            .http
            .get(url)
            .query(query)
            .send()
            .await
            .map_err(|_| WeatherError::Network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(WeatherError::Unavailable(status.to_string()));
        }
        response
            .json()
            .await
            .map_err(|e| WeatherError::Unavailable(e.without_url().to_string()))
    }

    async fn search_raw(&self, name: &str, count: u32) -> Result<Vec<Found>, WeatherError> {
        let response: SearchResponse = self
            .get(
                SEARCH_URL,
                &[
                    ("name", name.to_owned()),
                    ("count", count.to_string()),
                    ("language", "en".to_owned()),
                    ("format", "json".to_owned()),
                ],
            )
            .await?;
        Ok(response.results)
    }

    /// Towns and cities matching what the user typed, best first.
    pub async fn search(&self, query: &str) -> Result<Vec<Place>, WeatherError> {
        let query = query.trim();
        if query.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let found = self.search_raw(query, 8).await?;
        Ok(found.into_iter().map(Place::from).collect())
    }

    /// The daily and hourly forecast at a point, from today (in the place's time zone).
    pub async fn forecast(
        &self,
        latitude: f64,
        longitude: f64,
        unit: TemperatureUnit,
    ) -> Result<Arc<Forecast>, WeatherError> {
        // About a kilometre: the same town shares one forecast.
        let key = (format!("{latitude:.2},{longitude:.2}"), unit);
        if let Some((at, forecast)) = lock(&self.forecasts).get(&key) {
            if at.elapsed() < FORECAST_TTL {
                return Ok(forecast.clone());
            }
        }
        let mut query = vec![
            ("latitude", format!("{latitude:.4}")),
            ("longitude", format!("{longitude:.4}")),
            (
                "daily",
                "weather_code,temperature_2m_max,temperature_2m_min".to_owned(),
            ),
            ("hourly", "weather_code,precipitation,is_day".to_owned()),
            ("timezone", "auto".to_owned()),
            ("forecast_days", FORECAST_DAYS.to_string()),
        ];
        if unit == TemperatureUnit::Fahrenheit {
            query.push(("temperature_unit", "fahrenheit".to_owned()));
        }
        let response: ForecastResponse = self.get(FORECAST_URL, &query).await?;
        let forecast = Arc::new(Forecast {
            hours: hours_of(
                response.hourly,
                &response.timezone,
                response.utc_offset_seconds,
            ),
            days: days_of(response.daily),
        });
        lock(&self.forecasts).insert(key, (Instant::now(), forecast.clone()));
        Ok(forecast)
    }

    /// The town an event's location is in, if one can be told from its text.
    async fn locate(&self, location: &str) -> Result<Option<Place>, WeatherError> {
        let key = location.trim().to_lowercase();
        if let Some(place) = lock(&self.locations).get(&key) {
            return Ok(place.clone());
        }
        let mut found = Vec::new();
        for (order, query) in location_queries(location).into_iter().enumerate() {
            for result in self.search_raw(&query, 10).await? {
                found.push((order, query.clone(), result));
            }
        }
        let place = pick(location, found).map(Place::from);
        lock(&self.locations).insert(key, place.clone());
        Ok(place)
    }

    /// The forecast for an event's location; `None` when no town can be told from it.
    pub async fn for_location(
        &self,
        location: &str,
        unit: TemperatureUnit,
    ) -> Result<Option<LocationForecast>, WeatherError> {
        let Some(place) = self.locate(location).await? else {
            return Ok(None);
        };
        let forecast = self.forecast(place.latitude, place.longitude, unit).await?;
        Ok(Some(LocationForecast {
            place,
            days: forecast.days.clone(),
        }))
    }
}

/// Days with a code and both temperatures; Open-Meteo sends `null` where a model has no value.
fn days_of(daily: Daily) -> Vec<DayForecast> {
    daily
        .time
        .into_iter()
        .zip(daily.weather_code)
        .zip(
            daily
                .temperature_2m_max
                .into_iter()
                .zip(daily.temperature_2m_min),
        )
        .filter_map(|((date, code), (high, low))| {
            Some(DayForecast {
                date,
                code: code?,
                high: high?,
                low: low?,
            })
        })
        .collect()
}

/// Hours with a code; their local wall times in `zone` turned into UTC instants. A wall time
/// that happens twice (clocks going back) takes the first; one that never happens (clocks
/// going forward) is left out. A zone chrono-tz doesn't know falls back on `offset`.
fn hours_of(hourly: Hourly, zone: &str, offset: i32) -> Vec<HourForecast> {
    use chrono::{FixedOffset, NaiveDateTime, TimeZone};
    let tz: Option<chrono_tz::Tz> = zone.parse().ok();
    let fixed = FixedOffset::east_opt(offset).unwrap_or(FixedOffset::east_opt(0).unwrap());
    hourly
        .time
        .into_iter()
        .zip(hourly.weather_code)
        .zip(hourly.precipitation.into_iter().zip(hourly.is_day))
        .filter_map(|((time, code), (precipitation, is_day))| {
            let local = NaiveDateTime::parse_from_str(&time, "%Y-%m-%dT%H:%M").ok()?;
            let at = match tz {
                Some(tz) => tz
                    .from_local_datetime(&local)
                    .earliest()?
                    .timestamp_millis(),
                None => fixed
                    .from_local_datetime(&local)
                    .single()?
                    .timestamp_millis(),
            };
            Some(HourForecast {
                at,
                code: code?,
                precipitation: precipitation.unwrap_or(0.0),
                is_day: is_day.unwrap_or(1) == 1,
            })
        })
        .collect()
}

/// The parts of an event's location worth searching for a town, last part first (addresses end
/// with the town, region and country): words with digits (street numbers, postcodes) dropped,
/// parts shorter than three letters skipped, links ignored.
fn location_queries(location: &str) -> Vec<String> {
    if location.contains("://") {
        return Vec::new();
    }
    let mut parts: Vec<String> = location
        .split([',', ';', '\n'])
        .map(|part| {
            part.split_whitespace()
                .filter(|w| !w.chars().any(|c| c.is_ascii_digit()))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|part| part.chars().filter(|c| c.is_alphabetic()).count() >= 3)
        .collect();
    parts.reverse();
    parts.dedup();
    parts.truncate(MAX_LOCATION_QUERIES);
    parts
}

/// The best town among the search results for each part of `location`. A result counts only
/// when its name is the part itself (the geocoder matches loosely, and "Joe's Pizza" mustn't
/// become a town called Joes) and it's a populated place (not a country or state). It scores
/// for its region and country appearing elsewhere in the location; ties go to the part found
/// first, then to Open-Meteo's order (bigger towns first).
fn pick(location: &str, found: Vec<(usize, String, Found)>) -> Option<Found> {
    let text = fold(location);
    let words: Vec<&str> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has_word = |w: &str| words.contains(&w);
    let score = |f: &Found| {
        let mut score = 0;
        if let Some(region) = &f.admin1 {
            let region = fold(region);
            let abbreviation = (f.country_code.as_deref() == Some("US"))
                .then(|| us_state_code(&region))
                .flatten();
            if text.contains(&region) || abbreviation.is_some_and(has_word) {
                score += 2;
            }
        }
        let code = f.country_code.as_deref().map(str::to_lowercase);
        let country = f.country.as_deref().map(fold);
        let named = country.as_deref().is_some_and(|c| text.contains(c))
            || code.as_deref().is_some_and(|c| {
                has_word(c) || country_aliases(c).iter().any(|a| text.contains(a))
            });
        if named {
            score += 1;
        }
        score
    };
    let mut best: Option<(i32, Found)> = None;
    for (_, query, result) in found {
        let populated = result
            .feature_code
            .as_deref()
            .is_none_or(|code| code.starts_with("PPL"));
        if !populated || fold(&result.name) != fold(&query) {
            continue;
        }
        let s = score(&result);
        if best.as_ref().is_none_or(|(b, _)| s > *b) {
            best = Some((s, result));
        }
    }
    best.map(|(_, f)| f)
}

/// Lower case without the common Latin accents, so "Zurich" matches "Zürich".
fn fold(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
            'ç' | 'č' | 'ć' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
            'ñ' | 'ń' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
            'ś' | 'š' | 'ş' => 's',
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
            'ý' | 'ÿ' => 'y',
            'ź' | 'ż' | 'ž' => 'z',
            'ł' => 'l',
            'ř' => 'r',
            'ß' => 's',
            '’' => '\'',
            other => other,
        })
        .collect()
}

/// Other ways an address names a country than its English name or ISO code.
fn country_aliases(code: &str) -> &'static [&'static str] {
    match code {
        "us" => &["usa", "u.s."],
        "gb" => &["uk", "england", "scotland", "wales", "northern ireland"],
        "ae" => &["uae"],
        _ => &[],
    }
}

/// The postal abbreviation of a US state (lower case), as Google's addresses write it.
fn us_state_code(state: &str) -> Option<&'static str> {
    const STATES: &[(&str, &str)] = &[
        ("alabama", "al"),
        ("alaska", "ak"),
        ("arizona", "az"),
        ("arkansas", "ar"),
        ("california", "ca"),
        ("colorado", "co"),
        ("connecticut", "ct"),
        ("delaware", "de"),
        ("district of columbia", "dc"),
        ("florida", "fl"),
        ("georgia", "ga"),
        ("hawaii", "hi"),
        ("idaho", "id"),
        ("illinois", "il"),
        ("indiana", "in"),
        ("iowa", "ia"),
        ("kansas", "ks"),
        ("kentucky", "ky"),
        ("louisiana", "la"),
        ("maine", "me"),
        ("maryland", "md"),
        ("massachusetts", "ma"),
        ("michigan", "mi"),
        ("minnesota", "mn"),
        ("mississippi", "ms"),
        ("missouri", "mo"),
        ("montana", "mt"),
        ("nebraska", "ne"),
        ("nevada", "nv"),
        ("new hampshire", "nh"),
        ("new jersey", "nj"),
        ("new mexico", "nm"),
        ("new york", "ny"),
        ("north carolina", "nc"),
        ("north dakota", "nd"),
        ("ohio", "oh"),
        ("oklahoma", "ok"),
        ("oregon", "or"),
        ("pennsylvania", "pa"),
        ("rhode island", "ri"),
        ("south carolina", "sc"),
        ("south dakota", "sd"),
        ("tennessee", "tn"),
        ("texas", "tx"),
        ("utah", "ut"),
        ("vermont", "vt"),
        ("virginia", "va"),
        ("washington", "wa"),
        ("west virginia", "wv"),
        ("wisconsin", "wi"),
        ("wyoming", "wy"),
    ];
    STATES
        .iter()
        .find(|(name, _)| *name == state)
        .map(|(_, code)| *code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn town(name: &str, admin1: &str, code: &str, country: &str) -> Found {
        Found {
            name: name.into(),
            latitude: 1.0,
            longitude: 2.0,
            feature_code: Some("PPL".into()),
            country_code: Some(code.into()),
            country: Some(country.into()),
            admin1: Some(admin1.into()),
            timezone: Some("UTC".into()),
        }
    }

    fn found(location: &str, results: Vec<(&str, Found)>) -> Option<Found> {
        let queries = location_queries(location);
        let tagged = results
            .into_iter()
            .map(|(q, f)| {
                let order = queries.iter().position(|x| x == q).expect("a query");
                (order, q.to_owned(), f)
            })
            .collect();
        pick(location, tagged)
    }

    #[test]
    fn location_queries_are_the_address_parts_without_numbers_last_first() {
        assert_eq!(
            location_queries("Joe's Pizza, 1 Broadway, New York, NY 10004, USA"),
            ["USA", "New York", "Broadway", "Joe's Pizza"]
        );
        assert_eq!(location_queries("Paris"), ["Paris"]);
        assert!(location_queries("4B, 12 NE").is_empty());
        assert!(location_queries("https://zoom.us/j/123").is_empty());
    }

    #[test]
    fn picks_the_town_whose_state_and_country_the_address_names() {
        let place = found(
            "Joe's, 100 Main St, Springfield, IL 62701, USA",
            vec![
                (
                    "Springfield",
                    town("Springfield", "Missouri", "US", "United States"),
                ),
                (
                    "Springfield",
                    town("Springfield", "Illinois", "US", "United States"),
                ),
                ("USA", town("Usa", "Oita", "JP", "Japan")),
            ],
        )
        .unwrap();
        assert_eq!(place.admin1.as_deref(), Some("Illinois"));
    }

    #[test]
    fn a_street_that_shares_a_towns_name_loses_to_the_town() {
        let place = found(
            "1 Broadway, New York, NY 10004, USA",
            vec![
                (
                    "Broadway",
                    town("Broadway", "Virginia", "US", "United States"),
                ),
                (
                    "New York",
                    town("New York", "New York", "US", "United States"),
                ),
            ],
        )
        .unwrap();
        assert_eq!(place.name, "New York");
    }

    #[test]
    fn only_a_place_named_exactly_like_a_part_counts() {
        // The geocoder's loose match for a venue name isn't a town.
        assert!(found(
            "Joe's Pizza",
            vec![(
                "Joe's Pizza",
                town("Joes", "Colorado", "US", "United States")
            )],
        )
        .is_none());
        // Accents don't matter.
        let zurich = found(
            "Zurich",
            vec![("Zurich", town("Zürich", "Zurich", "CH", "Switzerland"))],
        );
        assert_eq!(zurich.unwrap().name, "Zürich");
    }

    #[test]
    fn countries_and_states_are_not_towns() {
        let mut georgia = town("Georgia", "Georgia", "US", "United States");
        georgia.feature_code = Some("ADM1".into());
        assert!(found("Georgia", vec![("Georgia", georgia)]).is_none());
    }

    #[test]
    fn days_without_a_value_are_left_out() {
        let daily: Daily = serde_json::from_str(
            r#"{"time":["2026-11-15","2026-11-16","2026-11-17"],
                "weather_code":[61,null,3],
                "temperature_2m_max":[7.9,11.3,9.7],
                "temperature_2m_min":[0.9,5.3,null]}"#,
        )
        .unwrap();
        assert_eq!(
            days_of(daily),
            [DayForecast {
                date: "2026-11-15".into(),
                code: 61,
                high: 7.9,
                low: 0.9
            }]
        );
    }

    fn hourly(times: &[&str]) -> Hourly {
        Hourly {
            time: times.iter().map(|t| t.to_string()).collect(),
            weather_code: times.iter().map(|_| Some(61)).collect(),
            precipitation: times.iter().map(|_| Some(1.2)).collect(),
            is_day: times.iter().map(|_| Some(1)).collect(),
        }
    }

    #[test]
    fn hours_are_utc_instants_through_a_dst_change() {
        // New York falls back at 2:00 on 2026-11-01: 1:00 happens twice, then EST (UTC-5).
        let hours = hours_of(
            hourly(&["2026-10-31T23:00", "2026-11-01T01:00", "2026-11-01T03:00"]),
            "America/New_York",
            -18000,
        );
        let at = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(
            hours.iter().map(|h| h.at).collect::<Vec<_>>(),
            [
                at("2026-11-01T03:00:00Z"),
                at("2026-11-01T05:00:00Z"),
                at("2026-11-01T08:00:00Z")
            ]
        );
        assert_eq!(hours[0].precipitation, 1.2);
        assert!(hours[0].is_day);
    }

    #[test]
    fn hours_skip_missing_codes_and_fall_back_on_the_offset() {
        let mut data = hourly(&["2026-11-16T10:00", "2026-11-16T11:00"]);
        data.weather_code[1] = None;
        data.precipitation[0] = None;
        data.is_day[0] = Some(0);
        let hours = hours_of(data, "Nowhere/Unknown", 3600);
        assert_eq!(
            hours,
            [HourForecast {
                at: chrono::DateTime::parse_from_rfc3339("2026-11-16T09:00:00Z")
                    .unwrap()
                    .timestamp_millis(),
                code: 61,
                precipitation: 0.0,
                is_day: false,
            }]
        );
    }

    #[test]
    fn a_search_with_no_matches_has_no_results_field() {
        let empty: SearchResponse = serde_json::from_str(r#"{"generationtime_ms":0.07}"#).unwrap();
        assert!(empty.results.is_empty());
    }

    /// Needs the network. `cargo test -- --ignored weather_live`
    #[tokio::test]
    #[ignore]
    async fn weather_live() {
        let weather = WeatherService::new();
        let found = weather
            .for_location(
                "1 Broadway, New York, NY 10004, USA",
                TemperatureUnit::Fahrenheit,
            )
            .await
            .unwrap()
            .expect("a town");
        assert_eq!(found.place.name, "New York");
        assert!(found.days.len() >= 7, "{:?}", found.days);
        let home = weather
            .forecast(40.71, -74.01, TemperatureUnit::Fahrenheit)
            .await
            .unwrap();
        assert!(home.hours.len() >= 24 * 7, "{} hours", home.hours.len());
        let places = weather.search("Berlin").await.unwrap();
        assert_eq!(places[0].country.as_deref(), Some("Germany"));
    }
}
