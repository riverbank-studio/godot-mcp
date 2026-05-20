extends Control

@onready var score_label: Label = $ScoreLabel
@onready var health_bar: ProgressBar = $HealthBar
@onready var pause_button: Button = $PauseButton

func _ready() -> void:
	pause_button.pressed.connect(_on_pause_pressed)
	score_label.text = "Score: 0"

func _on_pause_pressed() -> void:
	get_tree().paused = not get_tree().paused
