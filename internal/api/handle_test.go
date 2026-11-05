package api

import "testing"

func TestNormalizeHandle(t *testing.T) {
	good := []struct{ in, fb, typ, h string }{
		{"@Tunde_Dev", "x", "x", "tunde_dev"},
		{"tunde_dev", "x", "x", "tunde_dev"},
		{"  @segun ", "x", "x", "segun"},
		{"https://x.com/Aisha_UI?s=21", "x", "x", "aisha_ui"},
		{"twitter.com/jemeel/", "linkedin", "x", "jemeel"},
		{"https://mobile.twitter.com/jemeel/status/1", "x", "x", "jemeel"},
		{"https://www.linkedin.com/in/Jane-Doe-123/", "x", "linkedin", "jane-doe-123"},
		{"linkedin.com/in/jemeel?trk=qr", "x", "linkedin", "jemeel"},
		{"jane-doe", "linkedin", "linkedin", "jane-doe"},
		{"https://www.linkedin.com/in/abdul-jemeel-odewole-393a0b105/", "x", "linkedin", "abdul-jemeel-odewole-393a0b105"},
	}
	for _, c := range good {
		typ, h, ok := NormalizeHandle(c.in, c.fb)
		if !ok || typ != c.typ || h != c.h {
			t.Errorf("%q (%s): got %s/%s/%v want %s/%s", c.in, c.fb, typ, h, ok, c.typ, c.h)
		}
	}
	bad := []struct{ in, fb string }{
		{"", "x"}, {"@", "x"}, {"way_too_long_for_x_handle", "x"}, {"has space", "x"},
		{"https://linkedin.com/company/acme", "x"}, {"jane-doe", "x"}, {"<script>", "linkedin"},
	}
	for _, c := range bad {
		if _, _, ok := NormalizeHandle(c.in, c.fb); ok {
			t.Errorf("%q (%s) should be rejected", c.in, c.fb)
		}
	}
}
