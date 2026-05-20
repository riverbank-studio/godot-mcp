## Scene tree has: UI/ScoreLabel (Label), UI/HealthBar (ProgressBar)
extends Control

@onready var _label: Label = $UI/ScoreLabel
@onready var _health_bar: ProgressBar = $UI/HealthBar

var score: int = 0

func add_score(points: int) -> void:
	score += points
	_label.text = "Score: %d" % score
