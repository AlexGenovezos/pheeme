//! Weather commands for Calendar mode: thin adapters over [`crate::weather::WeatherService`].

use super::CommandError;
use crate::weather::{DayForecast, LocationForecast, Place, TemperatureUnit, WeatherService};
use tauri::State;

/// Towns and cities matching what the user typed (Settings › Calendar › Home location).
#[tauri::command]
pub async fn weather_search_places(
    weather: State<'_, WeatherService>,
    query: String,
) -> Result<Vec<Place>, CommandError> {
    Ok(weather.search(&query).await?)
}

/// The daily forecast at a point, from today in that place.
#[tauri::command]
pub async fn weather_forecast(
    weather: State<'_, WeatherService>,
    latitude: f64,
    longitude: f64,
    unit: TemperatureUnit,
) -> Result<Vec<DayForecast>, CommandError> {
    Ok(weather.forecast(latitude, longitude, unit).await?.to_vec())
}

/// The forecast for an event's location, or `null` when no town can be told from it.
#[tauri::command]
pub async fn weather_for_location(
    weather: State<'_, WeatherService>,
    location: String,
    unit: TemperatureUnit,
) -> Result<Option<LocationForecast>, CommandError> {
    Ok(weather.for_location(&location, unit).await?)
}
