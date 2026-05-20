extends Control

var score_label: Label
var health_bar: ProgressBar
var pause_button: Button

func _ready() -> void:
	score_label = get_node("ScoreLabel")
	health_bar = get_node("HealthBar")
	pause_button = get_node("PauseButton")
	pause_button.pressed.connect(_on_pause_pressed)
	score_label.text = "Score: 0"

func _on_pause_pressed() -> void:
	get_tree().paused = not get_tree().paused
