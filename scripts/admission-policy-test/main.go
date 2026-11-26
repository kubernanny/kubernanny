package main

import (
	"fmt"
	"os"
	"os/signal"

	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

func main() {
	env := &envtest.Environment{BinaryAssetsDirectory: os.Args[1]}
	cfg, err := env.Start()
	if err != nil {
		panic(err)
	}
	user, err := env.AddUser(envtest.User{Name: "admin", Groups: []string{"system:masters"}}, cfg)
	if err != nil {
		panic(err)
	}
	kc, err := user.KubeConfig()
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Args[2], kc, 0o600); err != nil {
		panic(err)
	}
	fmt.Println("READY")
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, os.Kill)
	<-c
	env.Stop()
}
