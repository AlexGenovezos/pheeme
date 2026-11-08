//! When new-mail alerts may appear. One schedule covers every account.
use chrono::{Datelike, NaiveDateTime, Timelike, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleMode {
    Always,
    WorkHours,
    Off,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotifySchedule {
    pub mode: ScheduleMode,
    pub start_hour: u8,
    pub end_hour: u8,
    pub weekdays_only: bool,
}

impl Default for NotifySchedule {
    fn default() -> Self {
        Self {
            mode: ScheduleMode::Always,
            start_hour: 9,
            end_hour: 17,
            weekdays_only: true,
        }
    }
}

impl NotifySchedule {
    /// Whether an alert at this local time may be shown. The end hour is exclusive, a range
    /// that ends before it starts runs overnight, and equal hours mean all day.
    pub fn allows(&self, at: NaiveDateTime) -> bool {
        match self.mode {
            ScheduleMode::Always => true,
            ScheduleMode::Off => false,
            ScheduleMode::WorkHours => {
                if self.weekdays_only && matches!(at.weekday(), Weekday::Sat | Weekday::Sun) {
                    return false;
                }
                let hour = at.hour() as u8;
                let (start, end) = (self.start_hour, self.end_hour);
                if start == end {
                    true
                } else if start < end {
                    hour >= start && hour < end
                } else {
                    hour >= start || hour < end
                }
            }
        }
    }

    pub fn valid(&self) -> bool {
        self.start_hour <= 23 && self.end_hour <= 23
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    // 2026-11-09 is a Monday.
    fn at(day: u32, hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, day)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    fn work(start_hour: u8, end_hour: u8, weekdays_only: bool) -> NotifySchedule {
        NotifySchedule {
            mode: ScheduleMode::WorkHours,
            start_hour,
            end_hour,
            weekdays_only,
        }
    }

    #[test]
    fn schedule_work_hours_weekday() {
        let s = work(9, 17, true);
        assert!(s.allows(at(9, 9, 0)));
        assert!(s.allows(at(13, 16, 59)));
        assert!(!s.allows(at(9, 17, 0)));
        assert!(!s.allows(at(9, 8, 59)));
        assert!(!s.allows(at(14, 12, 0)));
        assert!(work(9, 17, false).allows(at(14, 12, 0)));
    }

    #[test]
    fn schedule_overnight_range_wraps_midnight() {
        let s = work(22, 6, false);
        assert!(s.allows(at(9, 23, 30)));
        assert!(s.allows(at(9, 5, 59)));
        assert!(!s.allows(at(9, 12, 0)));
    }

    #[test]
    fn schedule_equal_hours_is_all_day() {
        assert!(work(9, 9, true).allows(at(9, 3, 0)));
    }

    #[test]
    fn schedule_off_and_always() {
        let mut s = NotifySchedule::default();
        assert!(s.allows(at(14, 3, 0)));
        s.mode = ScheduleMode::Off;
        assert!(!s.allows(at(9, 12, 0)));
    }

    #[test]
    fn schedule_json_is_camel_case_and_bad_json_is_not_parsed() {
        let json = serde_json::to_string(&work(9, 17, true)).unwrap();
        assert_eq!(
            json,
            r#"{"mode":"workHours","startHour":9,"endHour":17,"weekdaysOnly":true}"#
        );
        assert!(serde_json::from_str::<NotifySchedule>("nope").is_err());
    }
}
