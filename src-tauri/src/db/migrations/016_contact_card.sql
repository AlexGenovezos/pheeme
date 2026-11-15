-- What a contact card shows beyond name and address, from the People API download: the first
-- phone number, the organization ("Title at Company") and a photo the person chose (Google's
-- generated initial photos are left out). Filled by the next download.
ALTER TABLE google_contacts ADD COLUMN phone TEXT;
ALTER TABLE google_contacts ADD COLUMN organization TEXT;
ALTER TABLE google_contacts ADD COLUMN photo_url TEXT;
