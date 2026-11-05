// Package migrations holds the SQL schema, applied in filename order and
// tracked with PRAGMA user_version.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
