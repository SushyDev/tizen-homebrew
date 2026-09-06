// Package tui is the guided install: the screens, in order, that take one television from a factory
// set to a working Tizen Homebrew.
//
// Each step either moves on or stops with something the person at the keyboard can act on. Nothing
// here talks to the television directly; the steps call into the other packages and render what
// comes back.
package tui

import (
	"context"
	"fmt"
	"strings"

	"github.com/SushyDev/tizen-homebrew/installer/internal/discover"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type step int

const (
	stepIntro step = iota
	stepSweeping
	stepPicking
	stepChecking
	stepStalled
	stepUnbuilt
)

var (
	title    = lipgloss.NewStyle().Bold(true)
	dim      = lipgloss.NewStyle().Faint(true)
	good     = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	bad      = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	warn     = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	chosen   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6"))
	indented = lipgloss.NewStyle().MarginLeft(2)
)

type sweptMsg struct {
	televisions []discover.TV
	prefixes    []string
}

type checkedMsg struct {
	tv     discover.TV
	reason string
}

type model struct {
	step        step
	spinner     spinner.Model
	mine        []string
	primary     string
	prefixes    []string
	televisions []discover.TV
	cursor      int
	picked      discover.TV
	stall       string
	quitting    bool
}

// New builds the program's starting state, with this machine's addresses already in hand: the first
// screen has to name them before anything has been discovered.
func New() *tea.Program {
	spin := spinner.New()
	spin.Spinner = spinner.Dot

	prefixes, mine := discover.Subnets()

	return tea.NewProgram(model{
		step:     stepIntro,
		spinner:  spin,
		mine:     mine,
		prefixes: prefixes,
		primary:  discover.PrimaryAddress(),
	})
}

func (m model) Init() tea.Cmd {
	return m.spinner.Tick
}

func sweep() tea.Cmd {
	return func() tea.Msg {
		televisions, prefixes := discover.Sweep(context.Background())
		return sweptMsg{televisions: televisions, prefixes: prefixes}
	}
}

// The set has to be in developer mode before anything else can work. Its reported developerIP is
// deliberately not judged: it has claimed 127.0.0.1 during an install that worked, so the honest
// test is the sdb connection itself, one step further on.
func check(tv discover.TV) tea.Cmd {
	return func() tea.Msg {
		if !tv.DeveloperOn {
			return checkedMsg{tv: tv, reason: "developer mode is off on that set"}
		}

		return checkedMsg{tv: tv}
	}
}

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch message := message.(type) {
	case tea.KeyMsg:
		return m.key(message)

	case spinner.TickMsg:
		var command tea.Cmd
		m.spinner, command = m.spinner.Update(message)
		return m, command

	case sweptMsg:
		m.televisions = message.televisions
		m.prefixes = message.prefixes
		m.step = stepPicking
		return m, nil

	case checkedMsg:
		if message.reason != "" {
			m.stall = message.reason
			m.step = stepStalled
			return m, nil
		}

		m.picked = message.tv
		m.step = stepUnbuilt
		return m, nil
	}

	return m, nil
}

func (m model) key(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch message.String() {
	case "ctrl+c", "q":
		m.quitting = true
		return m, tea.Quit

	case "up", "k":
		if m.step == stepPicking && m.cursor > 0 {
			m.cursor--
		}

	case "down", "j":
		if m.step == stepPicking && m.cursor < len(m.televisions)-1 {
			m.cursor++
		}

	case "enter":
		switch m.step {
		case stepIntro:
			m.step = stepSweeping
			return m, tea.Batch(m.spinner.Tick, sweep())

		case stepPicking:
			if len(m.televisions) == 0 {
				m.step = stepSweeping
				return m, tea.Batch(m.spinner.Tick, sweep())
			}

			m.picked = m.televisions[m.cursor]
			m.step = stepChecking

			return m, tea.Batch(m.spinner.Tick, check(m.picked))

		case stepStalled:
			m.step = stepSweeping
			m.stall = ""

			return m, tea.Batch(m.spinner.Tick, sweep())
		}
	}

	return m, nil
}

func (m model) View() string {
	if m.quitting {
		return ""
	}

	switch m.step {
	case stepIntro:
		return m.intro()
	case stepSweeping:
		return m.sweeping()
	case stepPicking:
		return m.picking()
	case stepChecking:
		return indented.Render(m.spinner.View()+" asking "+m.picked.IP+"...") + "\n"
	case stepStalled:
		return m.stalled()
	case stepUnbuilt:
		return m.unbuilt()
	}

	return ""
}

func (m model) intro() string {
	// A machine with a VM bridge or a VPN has several addresses and only one of them is the one a
	// television can reach, so the routed one is the answer and the rest are a footnote.
	here := m.primary
	if here == "" {
		here = strings.Join(m.mine, " or ")
	}
	if here == "" {
		here = "this machine's address"
	}

	var others []string
	for _, address := range m.mine {
		if address != m.primary {
			others = append(others, address)
		}
	}

	lines := []string{
		title.Render("Tizen Homebrew"),
		"",
		"On the television, before anything else:",
		"",
		indented.Render("1. Open " + chosen.Render("Apps") + ", then press " + chosen.Render("12345") + " (or hold Enter)."),
		indented.Render("2. Turn " + chosen.Render("Developer mode") + " on."),
		indented.Render("3. Set " + chosen.Render("Host PC IP") + " to " + chosen.Render(here) + "."),
		indented.Render("4. " + chosen.Render("Restart the television") + " — properly, not standby."),
		"",
		dim.Render("  That last one matters: the set only reads Host PC IP at startup, so a"),
		dim.Render("  change without a restart does nothing at all."),
		"",
	}

	if len(others) > 0 {
		lines = append(lines,
			dim.Render("  This machine also answers to "+strings.Join(others, " and ")+", which a"),
			dim.Render("  television will not reach unless it is on that network."),
			"")
	}

	lines = append(lines,
		dim.Render("  Enter when it is back on  ·  q to quit"),
		"")

	return strings.Join(lines, "\n")
}

func (m model) sweeping() string {
	where := "this network"
	if len(m.prefixes) > 0 {
		where = strings.Join(m.prefixes, ".0/24, ") + ".0/24"
	}

	return "\n" + indented.Render(m.spinner.View()+" looking for televisions on "+where+"...") + "\n"
}

func (m model) picking() string {
	if len(m.televisions) == 0 {
		return strings.Join([]string{
			"",
			indented.Render(bad.Render("Nothing answered.")),
			"",
			dim.Render("  A set has to be on, and on the same network as this machine — a guest"),
			dim.Render("  network or a VPN is enough to hide it."),
			"",
			dim.Render("  Enter to look again  ·  q to quit"),
			"",
		}, "\n")
	}

	lines := []string{"", indented.Render(good.Render(fmt.Sprintf("Found %s.", counted(len(m.televisions))))), ""}

	for at, tv := range m.televisions {
		mode := dim.Render("developer mode on")
		if !tv.DeveloperOn {
			mode = warn.Render("developer mode OFF")
		}

		row := fmt.Sprintf("%-24s %-16s %s", tv.Name, tv.IP, mode)

		if at == m.cursor {
			lines = append(lines, indented.Render(chosen.Render("> "+row)))
			continue
		}

		lines = append(lines, indented.Render("  "+row))
	}

	return strings.Join(append(lines, "", dim.Render("  ↑↓ to choose  ·  Enter to use it  ·  q to quit"), ""), "\n")
}

func (m model) stalled() string {
	return strings.Join([]string{
		"",
		indented.Render(bad.Render(m.picked.Name + " — " + m.stall + ".")),
		"",
		dim.Render("  On the set: Apps > 12345 (or hold Enter) > Settings, turn Developer"),
		dim.Render("  mode on, set Host PC IP, and restart it."),
		"",
		dim.Render("  Enter to look again  ·  q to quit"),
		"",
	}, "\n")
}

func (m model) unbuilt() string {
	return strings.Join([]string{
		"",
		indented.Render(good.Render(m.picked.Name + " at " + m.picked.IP + " is ready.")),
		"",
		dim.Render("  Minting and installing are not wired up yet — that is the next milestone."),
		"",
	}, "\n")
}

func counted(many int) string {
	if many == 1 {
		return "one television"
	}

	return fmt.Sprintf("%d televisions", many)
}
