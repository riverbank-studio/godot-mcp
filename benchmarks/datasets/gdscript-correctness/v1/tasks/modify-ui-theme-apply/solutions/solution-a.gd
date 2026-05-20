extends Control

func build_menu(items: Array[String]) -> void:
	for item in items:
		var button := Button.new()
		button.text = item
		add_child(button)

func apply_button_theme(button: Button, theme: Theme) -> void:
	button.theme = theme

func reset_button_theme(button: Button) -> void:
	button.theme = null

func set_panel_color(panel: PanelContainer, color: Color) -> void:
	var style_box := StyleBoxFlat.new()
	style_box.bg_color = color
	panel.add_theme_stylebox_override("panel", style_box)
