CREATE TABLE `atomic_mutation_guard` (
  `ok` integer NOT NULL CONSTRAINT `atomic_mutation_must_win` CHECK (`ok` = 1)
);
