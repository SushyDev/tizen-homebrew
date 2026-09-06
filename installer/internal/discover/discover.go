// Package discover finds Samsung televisions on the local network.
//
// Every Samsung set answers http://<ip>:8001/api/v2/ with its model and developer-mode state, so a
// sweep of the /24s this machine sits in finds them without sending anyone to their router. Asking
// with HTTP costs far more than the network does — a /24 takes about ten seconds that way and one
// and a half opened by hand — so the sweep knocks on the port first and only asks the few addresses
// that answered what they are.
package discover

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// DevicePort is the Samsung device API, open on every set whether or not developer mode is on.
const DevicePort = 8001

const (
	knockTimeout = 1500 * time.Millisecond
	askTimeout   = 5 * time.Second
	atOnce       = 254
)

// TV is one television that answered.
type TV struct {
	IP          string
	Name        string
	Model       string
	DeveloperOn bool
	DeveloperIP string
}

type deviceAPI struct {
	Device struct {
		Name          string `json:"name"`
		ModelName     string `json:"modelName"`
		Model         string `json:"model"`
		DeveloperMode string `json:"developerMode"`
		DeveloperIP   string `json:"developerIP"`
	} `json:"device"`
}

// Subnets returns the /24 prefixes this machine sits in, and its own addresses within them.
func Subnets() (prefixes []string, mine []string) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, nil
	}

	seen := map[string]bool{}

	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
			continue
		}

		addresses, err := item.Addrs()
		if err != nil {
			continue
		}

		for _, address := range addresses {
			ipNet, ok := address.(*net.IPNet)
			if !ok || ipNet.IP.To4() == nil {
				continue
			}

			ip := ipNet.IP.To4().String()
			mine = append(mine, ip)

			prefix := ip[:strings.LastIndex(ip, ".")]
			if !seen[prefix] {
				seen[prefix] = true
				prefixes = append(prefixes, prefix)
			}
		}
	}

	return prefixes, mine
}

// knock opens a socket and closes it: the cheapest question that separates 254 dead addresses from
// the handful worth asking properly.
func knock(ctx context.Context, ip string) bool {
	dialer := net.Dialer{Timeout: knockTimeout}

	conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", ip, DevicePort))
	if err != nil {
		return false
	}

	_ = conn.Close()

	return true
}

// Describe asks one address what it is. Something else may sit on 8001, so an answer that does not
// look like a television is not one rather than an error to report.
func Describe(ctx context.Context, ip string) (*TV, error) {
	ctx, cancel := context.WithTimeout(ctx, askTimeout)
	defer cancel()

	url := fmt.Sprintf("http://%s:%d/api/v2/", ip, DevicePort)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	var answer deviceAPI
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		return nil, err
	}

	device := answer.Device
	if device.ModelName == "" && device.Model == "" && device.Name == "" {
		return nil, fmt.Errorf("%s answered on %d but is not a television", ip, DevicePort)
	}

	return &TV{
		IP:          ip,
		Name:        plain(pick(device.Name, device.ModelName, device.Model)),
		Model:       device.ModelName,
		DeveloperOn: device.DeveloperMode == "1",
		DeveloperIP: device.DeveloperIP,
	}, nil
}

// Sweep knocks on every address in the local /24s and describes the ones that answered.
func Sweep(ctx context.Context) (televisions []TV, prefixes []string) {
	prefixes, mine := Subnets()

	ours := map[string]bool{}
	for _, ip := range mine {
		ours[ip] = true
	}

	var addresses []string
	for _, prefix := range prefixes {
		for host := 1; host < 255; host++ {
			if ip := fmt.Sprintf("%s.%d", prefix, host); !ours[ip] {
				addresses = append(addresses, ip)
			}
		}
	}

	var (
		wait      sync.WaitGroup
		guard     = make(chan struct{}, atOnce)
		mutex     sync.Mutex
		listening []string
	)

	for _, ip := range addresses {
		wait.Add(1)

		go func(ip string) {
			defer wait.Done()

			guard <- struct{}{}
			defer func() { <-guard }()

			if knock(ctx, ip) {
				mutex.Lock()
				listening = append(listening, ip)
				mutex.Unlock()
			}
		}(ip)
	}

	wait.Wait()

	for _, ip := range listening {
		wait.Add(1)

		go func(ip string) {
			defer wait.Done()

			tv, err := Describe(ctx, ip)
			if err != nil {
				return
			}

			mutex.Lock()
			televisions = append(televisions, *tv)
			mutex.Unlock()
		}(ip)
	}

	wait.Wait()

	sort.Slice(televisions, func(a, b int) bool {
		return numeric(televisions[a].IP) < numeric(televisions[b].IP)
	})

	return televisions, prefixes
}

func pick(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}

	return "Samsung TV"
}

// A set named `65" OLED` reports it as `65&quot; OLED`.
func plain(text string) string {
	var holder struct {
		Value string `xml:",chardata"`
	}

	if err := xml.Unmarshal([]byte("<t>"+text+"</t>"), &holder); err == nil {
		return holder.Value
	}

	return text
}

func numeric(ip string) uint32 {
	parsed := net.ParseIP(ip).To4()
	if parsed == nil {
		return 0
	}

	return uint32(parsed[0])<<24 | uint32(parsed[1])<<16 | uint32(parsed[2])<<8 | uint32(parsed[3])
}

// PrimaryAddress is the address this machine would use to reach the outside world, which on a
// machine with a virtual-machine bridge or a VPN is the only one of several worth typing into a
// television. Connecting a UDP socket sends nothing; it just asks the routing table to choose.
func PrimaryAddress() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()

	address, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return ""
	}

	return address.IP.String()
}
