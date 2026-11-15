// Correctness oracle: Go parents repeatedly wait for short multithreaded children.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
)

func main() {
	if len(os.Args) != 2 {
		panic("expected the absolute path to the Go vet binary")
	}
	const workers, iterations = 16, 8
	errors := make(chan error, workers)
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for iteration := 0; iteration < iterations; iteration++ {
				if err := exec.Command(os.Args[1], "-V=full").Run(); err != nil {
					errors <- err
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"ok": true, "commands": workers * iterations,
	})
}
