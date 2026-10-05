ALTER TABLE customers ADD COLUMN birth_date TEXT CHECK (birth_date IS NULL OR length(birth_date) = 10);
ALTER TABLE customers ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'unspecified'));
ALTER TABLE customers ADD COLUMN allergy_notes TEXT CHECK (allergy_notes IS NULL OR length(allergy_notes) <= 2000);
ALTER TABLE customer_visits ADD COLUMN treatment_notes TEXT CHECK (treatment_notes IS NULL OR length(treatment_notes) <= 2000);
