-- ============================================================
-- Bolão Copa 2026 — Top scorer candidates seed
-- ============================================================
-- ~50 likely contenders. Admin can add more later via UI.

truncate public.players restart identity cascade;

insert into public.players (full_name, team, position, shirt_number) values
  -- France
  ('Kylian Mbappé', 'France', 'ATA', 10),
  ('Ousmane Dembélé', 'France', 'ATA', 11),
  ('Bradley Barcola', 'France', 'ATA', 9),
  -- Argentina
  ('Lionel Messi', 'Argentina', 'ATA', 10),
  ('Julián Álvarez', 'Argentina', 'ATA', 9),
  ('Lautaro Martínez', 'Argentina', 'ATA', 22),
  -- Brazil
  ('Vinícius Júnior', 'Brazil', 'ATA', 7),
  ('Rodrygo', 'Brazil', 'ATA', 10),
  ('Endrick', 'Brazil', 'ATA', 9),
  ('Raphinha', 'Brazil', 'ATA', 11),
  ('Neymar', 'Brazil', 'ATA', 10),
  -- Norway
  ('Erling Haaland', 'Norway', 'ATA', 9),
  -- England
  ('Harry Kane', 'England', 'ATA', 9),
  ('Bukayo Saka', 'England', 'ATA', 7),
  ('Phil Foden', 'England', 'MEI', 8),
  ('Jude Bellingham', 'England', 'MEI', 10),
  -- Spain
  ('Lamine Yamal', 'Spain', 'ATA', 19),
  ('Nico Williams', 'Spain', 'ATA', 17),
  ('Álvaro Morata', 'Spain', 'ATA', 7),
  -- Portugal
  ('Cristiano Ronaldo', 'Portugal', 'ATA', 7),
  ('Bruno Fernandes', 'Portugal', 'MEI', 8),
  ('Rafael Leão', 'Portugal', 'ATA', 17),
  -- Germany
  ('Florian Wirtz', 'Germany', 'MEI', 17),
  ('Jamal Musiala', 'Germany', 'MEI', 10),
  ('Kai Havertz', 'Germany', 'ATA', 7),
  -- Egypt
  ('Mohamed Salah', 'Egypt', 'ATA', 10),
  -- Poland
  ('Robert Lewandowski', 'Poland', 'ATA', 9),
  -- Netherlands (if qualified)
  ('Cody Gakpo', 'Netherlands', 'ATA', 11),
  ('Memphis Depay', 'Netherlands', 'ATA', 10),
  -- Belgium
  ('Romelu Lukaku', 'Belgium', 'ATA', 10),
  ('Kevin De Bruyne', 'Belgium', 'MEI', 7),
  -- Italy
  ('Mateo Retegui', 'Italy', 'ATA', 9),
  -- Colombia
  ('Luis Díaz', 'Colombia', 'ATA', 7),
  ('James Rodríguez', 'Colombia', 'MEI', 10),
  -- Uruguay
  ('Darwin Núñez', 'Uruguay', 'ATA', 19),
  ('Federico Valverde', 'Uruguay', 'MEI', 15),
  -- USA
  ('Christian Pulisic', 'United States', 'ATA', 10),
  ('Folarin Balogun', 'United States', 'ATA', 9),
  -- Mexico
  ('Santiago Giménez', 'Mexico', 'ATA', 9),
  ('Hirving Lozano', 'Mexico', 'ATA', 22),
  -- Canada
  ('Jonathan David', 'Canada', 'ATA', 20),
  ('Alphonso Davies', 'Canada', 'DEF', 19),
  -- Morocco
  ('Achraf Hakimi', 'Morocco', 'DEF', 2),
  ('Youssef En-Nesyri', 'Morocco', 'ATA', 19),
  -- South Korea
  ('Son Heung-min', 'South Korea', 'ATA', 7),
  -- Senegal
  ('Sadio Mané', 'Senegal', 'ATA', 10),
  ('Nicolas Jackson', 'Senegal', 'ATA', 9),
  -- Switzerland
  ('Breel Embolo', 'Switzerland', 'ATA', 7),
  -- Croatia
  ('Andrej Kramarić', 'Croatia', 'ATA', 9),
  -- Denmark
  ('Rasmus Højlund', 'Denmark', 'ATA', 11),
  -- Japan
  ('Kaoru Mitoma', 'Japan', 'ATA', 9),
  ('Takefusa Kubo', 'Japan', 'ATA', 11);

-- Verify
-- select count(*) from public.players;
