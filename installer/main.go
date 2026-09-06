// Command tizen-homebrew-installer walks one television from a factory Samsung set to a working
// Tizen Homebrew install: it says what to change on the TV, finds the set on the network, mints a
// certificate against a Samsung account, installs the app over sdb and says what to change back.
//
// It is delivered as a single binary because the machine running it is assumed to have nothing —
// no Node, no Tizen Studio, no git.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/SushyDev/tizen-homebrew/installer/internal/discover"
	"github.com/SushyDev/tizen-homebrew/installer/internal/tui"
)

func main() {
	list := flag.Bool("list", false, "sweep for televisions, print what answered, and exit")
	flag.Parse()

	if *list {
		os.Exit(sweep())
	}

	if _, err := tui.New().Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// The plain listing, for a terminal that cannot run the interface and for checking the sweep itself.
func sweep() int {
	started := time.Now()

	televisions, prefixes := discover.Sweep(context.Background())

	for _, prefix := range prefixes {
		fmt.Printf("swept %s.0/24\n", prefix)
	}

	if len(televisions) == 0 {
		fmt.Println("nothing answered")
		return 1
	}

	for _, tv := range televisions {
		mode := "developer mode OFF"
		if tv.DeveloperOn {
			mode = "developer mode on"
		}

		fmt.Printf("  %-16s %-24s %-16s %s\n", tv.IP, tv.Name, tv.Model, mode)
	}

	fmt.Printf("\n%d in %s\n", len(televisions), time.Since(started).Round(time.Millisecond))

	return 0
}
