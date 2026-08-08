# Pi Plan Mode Guidelines

## Fresh implementation sessions

- Copy the live branch when creating a fresh implementation session because `pi --no-session` and `getSessionFile() === undefined` do not imply an empty in-memory branch.
