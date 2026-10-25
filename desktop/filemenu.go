package main

import (
	"encoding/json"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// addFileMenu registers the context menu of one reviewed file. The page opens
// it on a right-click and its data names the file, which each command hands
// back to the page.
func (d *desktopApp) addFileMenu(app *application.App, window *application.WebviewWindow) {
	command := func(name string) func(*application.Context) {
		return func(ctx *application.Context) {
			detail, _ := json.Marshal(map[string]string{"command": name, "path": ctx.ContextMenuData()})
			window.ExecJS(fmt.Sprintf("window.dispatchEvent(new CustomEvent('desktop:file-command', {detail: %s}))", detail))
		}
	}
	menu := app.ContextMenu.New()
	d.viewedItem = menu.AddCheckbox("Viewed", false).OnClick(command("viewed"))
	menu.AddSeparator()
	menu.Add("Copy Path").OnClick(command("copy-path"))
	menu.Add("Reveal in Finder").OnClick(command("reveal"))
	app.ContextMenu.Add("file", menu)
}

// OpenFileMenu shows the file menu at the page's x and y, ticked when the file is viewed.
func (d *desktopApp) OpenFileMenu(path string, x, y int, viewed bool) {
	_, window := d.native()
	if window == nil || d.viewedItem == nil {
		return
	}
	application.InvokeSync(func() { d.viewedItem.SetChecked(viewed) })
	window.OpenContextMenu(&application.ContextMenuData{Id: "file", X: x, Y: y, Data: path})
}
