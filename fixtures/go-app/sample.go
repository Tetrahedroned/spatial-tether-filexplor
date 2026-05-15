// Sample Go module for fixture tests.
package sample

import "fmt"

const DefaultTimeout = 30
const internalBuffer = 1024

type Connection struct {
	Host string
	port int
}

type Querier interface {
	Query(sql string) string
}

type ID = int

func PublicHelper(x int) int {
	return x * 2
}

func privateHelper(x int) int {
	return x + 1
}

func (c *Connection) Query(sql string) string {
	return fmt.Sprintf("executing on %s: %s", c.Host, sql)
}

func (c *Connection) close() {
	// no-op
}
